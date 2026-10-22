import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConnectorQueryError, ConnectorQueryName, jiraReleaseOutcomeKey, prepareSelectionInput, type ConnectorItem, type ConnectorProvider, type NlArgs } from '@quoky/core';

/**
 * Owner answer 1 of 2026-10-22 ("프로젝트 목록 스냅샷으로 채점"): the read scorers compare `jira.release` args by Core's final
 * outcome against a test-data snapshot of the visible Jira world (`jira-world.snapshot.v1.json`, provenance in its header).
 * The snapshot is served through a read-only connector, and Core's own path (`jiraReleaseOutcomeKey`: the handler's command
 * mapping and `lookupJiraRelease`) decides. Every `jira.release` case is scored the same way; every other entry keeps the
 * exact-args comparison.
 */
export interface JiraWorldSnapshot {
  readonly siteHost: string;
  readonly identity: string;
  readonly projects: ReadonlyArray<{ readonly key: string; readonly name: string }>;
  readonly releases: Readonly<Record<string, ReadonlyArray<{ readonly id: string; readonly name: string; readonly status: 'released' | 'unreleased' }>>>;
}

/** The source file, from `src/tools` and from the built `dist/tools` alike (the JSON is not copied by the build). */
export const JIRA_WORLD_SNAPSHOT_PATH = resolve(__dirname, '../../../../apps/quoky/src/tools/jira-world.snapshot.v1.json');

let cached: JiraWorldSnapshot | undefined;

export function loadJiraWorldSnapshot(path: string = JIRA_WORLD_SNAPSHOT_PATH): JiraWorldSnapshot {
  if (path === JIRA_WORLD_SNAPSHOT_PATH && cached !== undefined) return cached;
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as JiraWorldSnapshot;
  if (path === JIRA_WORLD_SNAPSHOT_PATH) cached = snapshot;
  return snapshot;
}

/** The snapshot as a read-only Jira connector: the project listing, a project's versions, and empty release items. */
export function snapshotJiraConnector(snapshot: JiraWorldSnapshot): ConnectorProvider {
  const versionsOf = (key: string): ConnectorItem[] =>
    (snapshot.releases[key] ?? []).map((version) => ({
      id: version.id,
      title: version.name,
      status: version.status,
      container: key,
      url: `https://${snapshot.siteHost}/projects/${key}/versions/${version.id}/tab/release-report-all-issues`,
    }));
  return {
    source: 'jira',
    readOnly: true,
    isAvailable: async () => true,
    async query(query) {
      if (query.query === ConnectorQueryName.CONTAINERS) return { source: 'jira', items: snapshot.projects.map((project) => ({ id: project.key, title: project.name, container: project.key })) };
      if (query.query === ConnectorQueryName.RELEASES) return { source: 'jira', items: versionsOf(String(query.params?.container ?? '')) };
      if (query.query === ConnectorQueryName.RELEASE_ITEMS) {
        const container = query.params?.container;
        const name = query.params?.releaseName;
        if (typeof name === 'string') {
          const keys = typeof container === 'string' ? [container] : Object.keys(snapshot.releases);
          const known = keys.some((key) => versionsOf(key).some((version) => version.title.toLowerCase() === name.toLowerCase()));
          if (!known) throw new ConnectorQueryError('NOT_FOUND');
        }
        return { source: 'jira', items: [] };
      }
      throw new ConnectorQueryError('UNSUPPORTED_QUERY');
    },
  };
}

/**
 * Whether two validated `jira.release` arg sets give the owner the same final outcome in the snapshot world (Core decides).
 * `text` is the case's owner message; `channel` whether it was asked in a channel (no `jira-project` grant).
 */
export async function sameJiraReleaseOutcome(text: string, got: NlArgs, want: NlArgs, options: { readonly channel?: boolean; readonly snapshot?: JiraWorldSnapshot } = {}): Promise<boolean> {
  const prepared = prepareSelectionInput(text);
  const groundingText = 'skip' in prepared ? '' : prepared.groundingText;
  const snapshot = options.snapshot ?? loadJiraWorldSnapshot();
  const connector = snapshotJiraConnector(snapshot);
  const key = (args: NlArgs) =>
    jiraReleaseOutcomeKey({ args, groundingText, connector, siteHost: snapshot.siteHost, identity: snapshot.identity, ...(options.channel === true ? { inChannel: true } : {}) });
  return (await key(got)) === (await key(want));
}

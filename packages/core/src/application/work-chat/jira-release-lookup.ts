import type { MessageBody } from '../../domain';
import { CONNECTOR_CONTAINER_KEY, CONNECTOR_QUERY_MAX_LIMIT, ConnectorQueryName, isConnectorQueryError } from '../../ports';
import type { ConnectorItem, ConnectorProvider, ConnectorQueryErrorReason, ConnectorResult } from '../../ports';
import { releaseLinkOnSite, type JiraReleaseLink } from './jira-release-link';
import {
  renderProjectAmbiguous,
  renderProjectNotFound,
  renderReleaseIssues,
  renderReleaseList,
  renderReleaseNotFound,
  renderReleaseUsage,
  type ReleaseProjectRef,
  type ReleaseScope,
} from './jira-release-renderer';

/**
 * ADR-0120 amendment A8: one Jira release lookup, deterministic and read-only. Core resolves what the owner named
 * against what the configured account can see, through three named queries (never JQL):
 *
 *  1. the project: a link on the configured site gives its key; otherwise the owner's project words are matched against
 *     the `containers` listing (key, exact name, then a normalized containment). Several matches are narrowed by the
 *     owner's release name when exactly one of them has it; otherwise the owner is asked. Nothing is guessed.
 *  2. the release: a link's version id; otherwise the owner's release words matched against the project's `releases`
 *     (exact, then without the closed release words such as 배포/릴리스/건). Not found: up to five of the project's release
 *     names. Without a project, the release name goes to `release-items` as a quoted literal and Jira decides.
 *     No release and a project: the project's release list.
 *  3. the items: `release-items`, any assignee unless the owner limited it to their own (`scope: mine`).
 */

export interface ReleaseLookupCommand {
  readonly release?: string;
  readonly project?: string;
  readonly scope: ReleaseScope;
  readonly links: readonly JiraReleaseLink[];
}

export type ReleaseLookupResult =
  | { readonly kind: 'body'; readonly body: MessageBody; readonly listed?: { readonly count: number; readonly truncated: boolean } }
  | { readonly kind: 'failure'; readonly reason: 'IDENTITY_MISSING' | ConnectorQueryErrorReason };

/** At most this many ambiguous projects are checked for the owner's release name. */
const DISAMBIGUATE_MAX = 5;
/**
 * Closed words that name a release rather than spell it ("20261015 배포건", "2.3 버전"): used only to compare the owner's
 * value with Jira's version names, never to route.
 */
const RELEASE_WORDS = ['배포건', '배포 건', '배포항목', '배포 항목', '배포', '릴리스', '릴리즈', '버전', '항목', '건', 'release', 'version', 'fix version', 'fixversion'];
/** Closed words that name a project rather than spell it ("차란차 운영 프로젝트"). */
const PROJECT_WORDS = ['프로젝트', 'project', '스페이스', 'space'];

export async function lookupJiraRelease(input: {
  readonly connector: ConnectorProvider;
  readonly command: ReleaseLookupCommand;
  /** The owner's Jira identity; required only for `scope: mine`. */
  readonly identity?: string;
  /** The configured Jira site host (links on any other host are ignored). */
  readonly siteHost?: string;
}): Promise<ReleaseLookupResult> {
  const { connector, command } = input;
  const onSite = releaseLinkOnSite(command.links, input.siteHost);
  const ignoredLink = command.links.length > 0 && onSite === undefined;
  if (command.scope === 'mine' && (input.identity === undefined || input.identity.length === 0)) return { kind: 'failure', reason: 'IDENTITY_MISSING' };
  try {
    if (!(await connector.isAvailable())) return { kind: 'failure', reason: 'UNAVAILABLE' };
    // 1. The project.
    let project: ReleaseProjectRef | undefined;
    let preResolved: ConnectorItem | undefined;
    if (onSite !== undefined) {
      project = { key: onSite.projectKey };
    } else if (command.project !== undefined) {
      const listed = await connector.query({ query: ConnectorQueryName.CONTAINERS });
      const candidates = matchProjects(itemsOf(listed), command.project);
      if (candidates.length === 0) return body(renderProjectNotFound(command.project, ignoredLink));
      if (candidates.length === 1) {
        project = refOf(candidates[0] as ConnectorItem);
      } else {
        const narrowed = command.release === undefined ? [] : await narrowByRelease(connector, candidates.slice(0, DISAMBIGUATE_MAX), command.release);
        if (narrowed.length !== 1) return body(renderProjectAmbiguous(command.project, candidates.map(refOf)));
        project = refOf(narrowed[0]!.project);
        preResolved = narrowed[0]!.release;
      }
    }
    // 2. The release.
    let release: { readonly id?: string; readonly name?: string; readonly url?: string };
    if (onSite?.versionId !== undefined) {
      const known = await releasesOf(connector, onSite.projectKey).catch(() => undefined);
      const match = known?.items.find((item) => item.id === onSite.versionId);
      release = { id: onSite.versionId, ...(match !== undefined ? { name: match.title, ...(match.url !== undefined ? { url: match.url } : {}) } : {}) };
    } else if (command.release !== undefined) {
      if (project !== undefined) {
        let match = preResolved;
        if (match === undefined) {
          const known = await releasesOf(connector, project.key);
          match = matchRelease(known.items, command.release);
          if (match === undefined) return body(renderReleaseNotFound(command.release, project, nearbyReleases(known.items, command.release)));
        }
        release = { id: match.id, name: match.title, ...(match.url !== undefined ? { url: match.url } : {}) };
      } else {
        release = { name: command.release };
      }
    } else if (project !== undefined) {
      const known = await releasesOf(connector, project.key);
      return body(renderReleaseList(project, known.items, known.truncated === true, ignoredLink));
    } else {
      return body(renderReleaseUsage(ignoredLink));
    }
    // 3. The items.
    const listed = await connector.query({
      query: ConnectorQueryName.RELEASE_ITEMS,
      params: {
        ...(project !== undefined ? { container: project.key } : {}),
        ...(release.id !== undefined ? { releaseId: release.id } : { releaseName: release.name as string }),
        ...(command.scope === 'mine' ? { assignee: input.identity as string } : {}),
        limit: CONNECTOR_QUERY_MAX_LIMIT,
      },
    });
    const items = itemsOf(listed).slice(0, CONNECTOR_QUERY_MAX_LIMIT);
    const truncated = listed.truncated === true || itemsOf(listed).length > items.length;
    const releaseUrl = release.url ?? (project !== undefined && release.id !== undefined && onSite !== undefined ? siteReleaseUrl(onSite.host, project.key, release.id) : undefined);
    return {
      kind: 'body',
      body: renderReleaseIssues({
        ...(project !== undefined ? { project } : {}),
        ...(release.name !== undefined ? { releaseName: release.name } : {}),
        ...(releaseUrl !== undefined ? { releaseUrl } : {}),
        scope: command.scope,
        items,
        truncated,
        ...(ignoredLink ? { ignoredLink } : {}),
      }),
      listed: { count: items.length, truncated },
    };
  } catch (error) {
    if (isConnectorQueryError(error) && error.reason === 'NOT_FOUND') {
      return body(renderReleaseNotFound(command.release ?? onSite?.versionId ?? '', namedProject(command, onSite), []));
    }
    if (isConnectorQueryError(error)) return { kind: 'failure', reason: error.reason };
    throw error;
  }
}

/** The project to name in a not-found answer: a link's key or a key-shaped owner value (never a guessed name). */
function namedProject(command: ReleaseLookupCommand, onSite: JiraReleaseLink | undefined): ReleaseProjectRef | undefined {
  if (onSite !== undefined) return { key: onSite.projectKey };
  return command.project !== undefined && CONNECTOR_CONTAINER_KEY.test(command.project.trim().toUpperCase()) ? { key: command.project.trim().toUpperCase() } : undefined;
}

function body(value: MessageBody): ReleaseLookupResult {
  return { kind: 'body', body: value };
}

function itemsOf(result: ConnectorResult): readonly ConnectorItem[] {
  return Array.isArray(result.items) ? result.items : [];
}

function refOf(item: ConnectorItem): ReleaseProjectRef {
  return { key: item.id, ...(item.title !== item.id ? { name: item.title } : {}) };
}

async function releasesOf(connector: ConnectorProvider, key: string): Promise<{ readonly items: readonly ConnectorItem[]; readonly truncated?: boolean }> {
  const result = await connector.query({ query: ConnectorQueryName.RELEASES, params: { container: key } });
  return { items: itemsOf(result), ...(result.truncated === true ? { truncated: true } : {}) };
}

/** The ambiguous projects that hold a release of the owner's name (each listing read once, read-only). */
async function narrowByRelease(
  connector: ConnectorProvider,
  candidates: readonly ConnectorItem[],
  releaseText: string,
): Promise<Array<{ readonly project: ConnectorItem; readonly release: ConnectorItem }>> {
  const found: Array<{ readonly project: ConnectorItem; readonly release: ConnectorItem }> = [];
  for (const candidate of candidates) {
    const known = await releasesOf(connector, candidate.id);
    const match = matchRelease(known.items, releaseText);
    if (match !== undefined) found.push({ project: candidate, release: match });
  }
  return found;
}

/** NFC, lower case, whitespace collapsed. */
function fold(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Letters and digits only (project names: "차란차운영2026" = "차란차 운영 2026"). */
function compact(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, '');
}

function withoutWords(text: string, words: readonly string[]): string {
  let out = ` ${fold(text)} `;
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A closed word at a word end (with an optional particle-free tail), never inside another word.
    out = out.replace(new RegExp(`(?<=[\\s\\p{N}])${escaped}(?=\\s)`, 'gu'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Projects matching the owner's words: an exact key, else an exact name (letters and digits only), else every project
 * whose name contains the words, or (a name of at least 3 characters) is contained in them.
 */
export function matchProjects(items: readonly ConnectorItem[], text: string): ConnectorItem[] {
  const key = text.trim().toUpperCase();
  if (CONNECTOR_CONTAINER_KEY.test(key)) {
    const byKey = items.filter((item) => item.id === key);
    if (byKey.length > 0) return byKey;
  }
  const stripped = withoutWords(text, PROJECT_WORDS);
  const wanted = compact(stripped.length > 0 ? stripped : text);
  if (wanted.length === 0) return [];
  const exact = items.filter((item) => compact(item.title) === wanted);
  if (exact.length > 0) return exact;
  return items.filter((item) => {
    const name = compact(item.title);
    return name.length > 0 && (name.includes(wanted) || (name.length >= 3 && wanted.includes(name)));
  });
}

/** The release named by the owner's words: exact (case and spacing aside), else without the closed release words. */
export function matchRelease(items: readonly ConnectorItem[], text: string): ConnectorItem | undefined {
  const wanted = fold(text);
  const exact = items.find((item) => fold(item.title) === wanted);
  if (exact !== undefined) return exact;
  const stripped = withoutWords(text, RELEASE_WORDS);
  if (stripped.length === 0 || stripped === wanted) return undefined;
  return items.find((item) => fold(item.title) === stripped);
}

/** Up to five release names closest to the owner's words (the longest common prefix first, then Jira's order). */
export function nearbyReleases(items: readonly ConnectorItem[], text: string): ConnectorItem[] {
  const wanted = withoutWords(text, RELEASE_WORDS) || fold(text);
  const prefix = (name: string): number => {
    const a = Array.from(fold(name));
    const b = Array.from(wanted);
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
    return n;
  };
  return items
    .map((item, index) => ({ item, index, score: prefix(item.title) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 5)
    .map((entry) => entry.item);
}

/** The release report page on the configured site (built from the validated key and id, never from the owner's URL). */
function siteReleaseUrl(host: string, key: string, id: string): string {
  return `https://${host}/projects/${encodeURIComponent(key)}/versions/${id}/tab/release-report-all-issues`;
}

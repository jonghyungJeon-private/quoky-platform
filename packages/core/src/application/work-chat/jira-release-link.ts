import { CONNECTOR_CONTAINER_KEY, CONNECTOR_RELEASE_ID } from '../../ports/connector-query';

/**
 * ADR-0120 amendment A8: Jira release links in the owner's own words, parsed deterministically. Pure: nothing is
 * fetched, ever. A link is used only when its host equals the configured Jira site ({@link releaseLinkOnSite}); the
 * project key and the version id it carries are then re-validated by the connector port and sent to the configured
 * site through the adapter's own base URL, so the owner's URL itself is never requested.
 *
 * Recognized paths (https only, no credentials, no port):
 *  - `/projects/<KEY>/versions/<id>[/…]` (the release page and its report tabs);
 *  - `/browse/<KEY>/fixforversion/<id>[/…]` (the older release page);
 *  - `/projects/<KEY>[/…]` and `/browse/<KEY>` (a project only; the release then comes from the owner's words).
 * An issue link (`/browse/KEY-1`) is not a release link.
 */

export interface JiraReleaseLink {
  /** Lower-case host name of the link. */
  readonly host: string;
  readonly projectKey: string;
  /** Present for a release (version) page. */
  readonly versionId?: string;
}

/** At most this many links are read from one message. */
const MAX_LINKS = 5;
const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[)\]}>.,;:!?'"’”」』…]+$/u;
const RELEASE_PATH = /^\/(?:projects\/([A-Za-z][A-Za-z0-9_]*)\/versions\/(\d+)|browse\/([A-Za-z][A-Za-z0-9_]*)\/fixforversion\/(\d+))(?:\/|$)/iu;
const PROJECT_PATH = /^\/(?:projects\/([A-Za-z][A-Za-z0-9_]*)(?:\/|$)|browse\/([A-Za-z][A-Za-z0-9_]*)\/?$)/iu;

/** Every Jira-shaped release or project link in `text`, in order (any host; see {@link releaseLinkOnSite}). */
export function parseJiraReleaseLinks(text: string): JiraReleaseLink[] {
  const links: JiraReleaseLink[] = [];
  for (const match of text.normalize('NFC').matchAll(URL_CANDIDATE)) {
    if (links.length >= MAX_LINKS) break;
    const link = parseOne(match[0].replace(TRAILING_PUNCTUATION, ''));
    if (link !== undefined) links.push(link);
  }
  return links;
}

/** Whether `text` holds at least one Jira-shaped release or project link (any host). */
export function hasJiraReleaseLink(text: string): boolean {
  return parseJiraReleaseLinks(text).length > 0;
}

/**
 * The first link whose host is exactly the configured site host (case-insensitive), or `undefined`. A link on any
 * other host is ignored: it is never fetched and contributes nothing.
 */
export function releaseLinkOnSite(links: readonly JiraReleaseLink[], siteHost: string | undefined): JiraReleaseLink | undefined {
  const site = normalizeSiteHost(siteHost);
  if (site === undefined) return undefined;
  return links.find((link) => link.host === site);
}

/** A configured site (`example.atlassian.net` or `https://example.atlassian.net`) as a lower-case host name. */
export function normalizeSiteHost(siteHost: string | undefined): string | undefined {
  if (siteHost === undefined || siteHost.trim().length === 0) return undefined;
  const candidate = /^https?:\/\//i.test(siteHost.trim()) ? siteHost.trim() : `https://${siteHost.trim()}`;
  try {
    const url = new URL(candidate);
    return url.hostname.length > 0 ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function parseOne(raw: string): JiraReleaseLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hostname.length === 0) return undefined;
  const host = url.hostname.toLowerCase();
  const release = RELEASE_PATH.exec(url.pathname);
  if (release !== null) {
    const projectKey = (release[1] ?? release[3] ?? '').toUpperCase();
    const versionId = release[2] ?? release[4] ?? '';
    if (!CONNECTOR_CONTAINER_KEY.test(projectKey) || !CONNECTOR_RELEASE_ID.test(versionId)) return undefined;
    return { host, projectKey, versionId };
  }
  // A release path whose id is not a valid version id is malformed: never read as "just the project".
  if (/\/(?:versions|fixforversion)(?:\/|$)/iu.test(url.pathname)) return undefined;
  const project = PROJECT_PATH.exec(url.pathname);
  if (project !== null) {
    const projectKey = (project[1] ?? project[2] ?? '').toUpperCase();
    if (!CONNECTOR_CONTAINER_KEY.test(projectKey)) return undefined;
    return { host, projectKey };
  }
  return undefined;
}

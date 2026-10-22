import type { MessageBody } from '../../domain';
import { CONNECTOR_CONTAINER_KEY, CONNECTOR_QUERY_MAX_LIMIT, ConnectorQueryName, isConnectorQueryError } from '../../ports';
import type { ConnectorItem, ConnectorProvider, ConnectorQueryErrorReason, ConnectorResult } from '../../ports';
import { releaseLinkOnSite, type JiraReleaseLink } from './jira-release-link';
import {
  renderProjectAmbiguous,
  renderProjectConfirm,
  renderProjectNotFound,
  releaseIssuesInDisplayOrder,
  renderNumberedReleaseIssues,
  renderReleaseIssues,
  renderReleaseList,
  renderReleaseNotFound,
  renderReleaseDmOnly,
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
  | {
      readonly kind: 'body';
      readonly body: MessageBody;
      /**
       * Owner decision B (2026-10-22): the body asks whether the owner meant this visible project (a near match of their
       * words). A yes runs the same lookup with the project's key (and the owner's release words, when they named one).
       */
      readonly confirm?: { readonly project: string; readonly release?: string };
      /**
       * The one visible project the reply is about (its release list, or a release not found in it), content-free (its key).
       * Absent for a reply about no single resolved project (not found, several projects, a refusal, the usage text).
       */
      readonly resolvedProject?: string;
      readonly listed?: { readonly count: number; readonly truncated: boolean };
      /** A6 R2 (numbered): the issues in display order and how many leading rows were certainly delivered. */
      readonly shown?: { readonly items: readonly ConnectorItem[]; readonly labelled: number };
    }
  | { readonly kind: 'failure'; readonly reason: 'IDENTITY_MISSING' | 'TIMEOUT' | ConnectorQueryErrorReason };

/** The lookup deadline passed between two queries: no further query is started. */
class ReleaseLookupAborted extends Error {
  constructor() {
    super('jira release lookup: deadline passed');
    this.name = 'ReleaseLookupAborted';
  }
}

/** At most this many ambiguous projects are checked for the owner's release name, each on its first page only. */
const DISAMBIGUATE_MAX = 5;
const DISAMBIGUATE_PAGE = 50;
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
  /** Aborted when the lookup deadline passes: checked before every query, so no query starts after it. */
  readonly signal?: AbortSignal;
  /**
   * The conversation is a channel, not a DM (owner decision 7, until the A9 surface permissions): every-assignee scope and
   * the project / release lists are refused there; the owner's own items of a named release follow `jira.issues`.
   */
  readonly inChannel?: boolean;
  /** A6 R2 (D1): number the issue rows and report the certainly delivered ones (`QUOKY_NL_ITEM_R2` not `off`). */
  readonly numbered?: boolean;
  /**
   * Owner decision B (2026-10-22): a project reached only by a near match of the owner's words is confirmed with the owner
   * first (`confirm` on the result). Only when the caller can keep the question open (a natural-language selection turn).
   */
  readonly confirmNear?: boolean;
}): Promise<ReleaseLookupResult> {
  let command = input.command;
  // The release text before a repeated project key was stripped: a release of exactly that name wins over the stripped one.
  let keyedRelease: string | undefined;
  const connector = guarded(input.connector, input.signal);
  const onSite = releaseLinkOnSite(command.links, input.siteHost);
  const ignoredLink = command.links.length > 0 && onSite === undefined;
  if (input.inChannel === true && command.scope === 'all') return body(renderReleaseDmOnly('all'));
  // A project / release list is a DM-only answer: refused before any read, the project catalog included.
  if (input.inChannel === true && command.release === undefined && onSite?.versionId === undefined && (command.project !== undefined || onSite !== undefined)) return body(renderReleaseDmOnly('list'));
  if (command.scope === 'mine' && (input.identity === undefined || input.identity.length === 0)) return { kind: 'failure', reason: 'IDENTITY_MISSING' };
  try {
    if (!(await connector.isAvailable())) return { kind: 'failure', reason: 'UNAVAILABLE' };
    // 0. A project key the selector left inside the release words ("OP26 20261015"): moved to `project` when it is a visible
    // key, or, when `project` already is that same visible key, stripped from the release (it only repeats the project).
    if (onSite === undefined && command.release !== undefined && splitKeyToken(command.release) !== undefined) {
      const listed = await connector.query({ query: ConnectorQueryName.CONTAINERS });
      if (command.project === undefined) {
        const split = splitKeyFromRelease(itemsOf(listed), command.release, listed.truncated === true);
        if (split !== undefined) command = { ...command, project: split.project, release: split.release };
      } else {
        const stripped = stripRedundantProjectKey(itemsOf(listed), command.project, command.release);
        if (stripped !== undefined) {
          keyedRelease = command.release;
          command = { ...command, release: stripped };
        }
      }
    }
    // 1. The project.
    let project: ReleaseProjectRef | undefined;
    let preResolved: ConnectorItem | undefined;
    // The complete project listing (never a truncated one): what a release word folded back into the project is checked on.
    let completeProjects: readonly ConnectorItem[] | undefined;
    if (onSite !== undefined) {
      project = { key: onSite.projectKey };
    } else if (command.project !== undefined) {
      const listed = await connector.query({ query: ConnectorQueryName.CONTAINERS });
      if (listed.truncated !== true) completeProjects = itemsOf(listed);
      const matched = matchProjectsTiered(itemsOf(listed), command.project);
      const candidates = matched.items;
      // Owner decision B (2026-10-22): the owner's words name no visible project as written (only whole words of a longer
      // name, or nothing): on a complete listing the near match is confirmed with the owner, never silently taken.
      if (input.confirmNear === true && completeProjects !== undefined && (matched.tier === 'words' || candidates.length === 0)) {
        const near = await resolveNearProject(connector, completeProjects, command.project, command.release, candidates);
        if (near.kind === 'confirm') return confirmBody(near.project, near.release, input.inChannel === true);
        if (near.kind === 'ambiguous') return body(input.inChannel === true ? renderReleaseDmOnly('list') : renderProjectAmbiguous(command.project, near.candidates.map(refOf)));
        return body(renderProjectNotFound(command.project, ignoredLink));
      }
      if (candidates.length === 0) return body(renderProjectNotFound(command.project, ignoredLink));
      // A truncated listing may hold unseen projects that match too: only an exact project key is proven unique there.
      const keyText = command.project.trim().toUpperCase();
      const exactKey = CONNECTOR_CONTAINER_KEY.test(keyText) && candidates.every((item) => item.id === keyText);
      const partialListing = listed.truncated === true && !exactKey;
      if (candidates.length === 1 && !partialListing) {
        project = refOf(candidates[0] as ConnectorItem);
      } else {
        // More candidates than the bound are never narrowed on a subset: the owner is asked.
        const narrowed =
          partialListing || command.release === undefined || candidates.length > DISAMBIGUATE_MAX
            ? undefined
            : await narrowByRelease(connector, candidates, command.release);
        // No candidate holds the release (proven on complete listings), and the project words with the release words name
        // exactly one of the candidates: the owner named that project alone ("차란차 운영" + "2026"), so its release list.
        const joined =
          narrowed !== undefined && !narrowed.unproven && narrowed.found.length === 0 && command.release !== undefined
            ? projectWithReleaseWords(completeProjects, command.project, command.release)
            : undefined;
        if (joined !== undefined && candidates.some((item) => item.id === joined.id)) {
          if (input.inChannel === true) return body(renderReleaseDmOnly('list'));
          const known = await releasesOf(connector, joined.id);
          return resolvedBody(renderReleaseList(refOf(joined), known.items, known.truncated === true, ignoredLink), joined.id);
        }
        const unresolved = narrowed === undefined || narrowed.unproven || narrowed.found.length !== 1;
        // Owner decision B: the release narrowing picked no single candidate (none holds it, more candidates than the bound,
        // or a partial version page proved nothing: live 2026-10-22, four "차란차 플랫폼 운영 20xx" projects), and the project
        // words with the release words are near exactly one visible project, one of these candidates, with the release not
        // seen in another candidate on the pages read ("Mobile App" + "2026" for "Mobile App Ops 2026"): that project is
        // confirmed (the same rule as the no-candidate path). Over the bound no version page is read: names only.
        if (input.confirmNear === true && joined === undefined && unresolved && command.release !== undefined) {
          const near = joinedNearConfirm(completeProjects, command.project, command.release, narrowed, candidates);
          if (near !== undefined) return confirmBody(near.project, near.release, input.inChannel === true);
        }
        if (unresolved) {
          return body(input.inChannel === true ? renderReleaseDmOnly('list') : renderProjectAmbiguous(command.project, candidates.map(refOf)));
        }
        project = refOf(narrowed.found[0]!.project);
        preResolved = narrowed.found[0]!.release;
      }
    }
    // 2. The release.
    // `raw`: the owner's words as written, tried once more when the stripped name is unknown to Jira ("Release 1.0").
    let release: { readonly id?: string; readonly name?: string; readonly url?: string; readonly raw?: string };
    if (onSite?.versionId !== undefined) {
      const known = await releasesOf(connector, onSite.projectKey).catch(() => undefined);
      const match = known?.items.find((item) => item.id === onSite.versionId);
      release = { id: onSite.versionId, ...(match !== undefined ? { name: match.title, ...(match.url !== undefined ? { url: match.url } : {}) } : {}) };
    } else if (command.release !== undefined) {
      if (project !== undefined) {
        let match = preResolved;
        if (match === undefined) {
          const known = await releasesOf(connector, project.key);
          const truncated = known.truncated === true;
          if (keyedRelease !== undefined) {
            // The owner's own wording (key included, release words normalized) first; the key-stripped name only when the
            // listing is complete and holds no release of the original name (a partial listing proves nothing absent).
            const original = resolveRelease(known.items, keyedRelease, truncated);
            match = original.item;
            if (match === undefined && !truncated && !original.ambiguous) match = resolveRelease(known.items, command.release, false).item;
            if (match === undefined) return resolvedBody(renderReleaseNotFound(keyedRelease, project, input.inChannel === true ? [] : nearbyReleases(known.items, keyedRelease)), project.key);
          } else {
            const resolved = resolveRelease(known.items, command.release, truncated);
            match = resolved.item;
            // The selector split the project's own trailing word off as a release ("차란차 운영" + "2026" for the project
            // "차란차 운영 2026"): no such release on a complete listing, and the two values together name exactly this
            // project, so the owner named the project alone: its release list (DM-only, like any list).
            if (match === undefined && !truncated && !resolved.ambiguous && projectWithReleaseWords(completeProjects, command.project, command.release)?.id === project.key) {
              if (input.inChannel === true) return body(renderReleaseDmOnly('list'));
              return resolvedBody(renderReleaseList(project, known.items, false, ignoredLink), project.key);
            }
          }
          if (match === undefined) return resolvedBody(renderReleaseNotFound(command.release, project, input.inChannel === true ? [] : nearbyReleases(known.items, command.release)), project.key);
        }
        release = { id: match.id, name: match.title, ...(match.url !== undefined ? { url: match.url } : {}) };
      } else {
        // The closed release words are not part of a version name ("20261015 배포건" → 20261015).
        release = { name: stripReleaseWords(command.release), ...(stripReleaseWords(command.release) !== command.release.trim() ? { raw: command.release.trim() } : {}) };
      }
    } else if (project !== undefined) {
      const known = await releasesOf(connector, project.key);
      return resolvedBody(renderReleaseList(project, known.items, known.truncated === true, ignoredLink), project.key);
    } else {
      return body(renderReleaseUsage(ignoredLink));
    }
    // 3. The items.
    const itemsOfRelease = (name: string | undefined) =>
      connector.query({
        query: ConnectorQueryName.RELEASE_ITEMS,
        params: {
          ...(project !== undefined ? { container: project.key } : {}),
          ...(release.id !== undefined ? { releaseId: release.id } : { releaseName: name as string }),
          ...(command.scope === 'mine' ? { assignee: input.identity as string } : {}),
          limit: CONNECTOR_QUERY_MAX_LIMIT,
        },
      });
    let listed: ConnectorResult;
    try {
      listed = await itemsOfRelease(release.name);
    } catch (error) {
      if (release.raw === undefined || !isConnectorQueryError(error) || error.reason !== 'NOT_FOUND') throw error;
      listed = await itemsOfRelease(release.raw);
      release = { name: release.raw };
    }
    // No version resolved (no project to list releases from) and nothing came back: not proven to exist, so not "no issues".
    if (release.id === undefined && itemsOf(listed).length === 0) return body(renderReleaseNotFound(command.release ?? '', project, []));
    const items = itemsOf(listed).slice(0, CONNECTOR_QUERY_MAX_LIMIT);
    const truncated = listed.truncated === true || itemsOf(listed).length > items.length;
    // The page link is the adapter's own release URL (Core builds no Jira URL); unknown when the release was not listed.
    const releaseUrl = release.url;
    const view = {
      ...(project !== undefined ? { project } : {}),
      ...(release.name !== undefined ? { releaseName: release.name } : {}),
      ...(releaseUrl !== undefined ? { releaseUrl } : {}),
      scope: command.scope,
      items,
      truncated,
      ...(ignoredLink ? { ignoredLink } : {}),
      ...(input.inChannel !== true ? { offerAllScope: true } : {}),
    };
    if (input.numbered === true) {
      const numbered = renderNumberedReleaseIssues(view);
      return {
        kind: 'body',
        body: numbered.body,
        listed: { count: items.length, truncated },
        shown: { items: releaseIssuesInDisplayOrder(items), labelled: numbered.labelled },
      };
    }
    return { kind: 'body', body: renderReleaseIssues(view), listed: { count: items.length, truncated } };
  } catch (error) {
    if (error instanceof ReleaseLookupAborted) return { kind: 'failure', reason: 'TIMEOUT' };
    if (isConnectorQueryError(error) && error.reason === 'NOT_FOUND') {
      return body(renderReleaseNotFound(command.release ?? onSite?.versionId ?? '', namedProject(command, onSite), []));
    }
    if (isConnectorQueryError(error)) return { kind: 'failure', reason: error.reason };
    throw error;
  }
}

/** The project-key part of one whitespace token: "OP26", or "OP26-20261015" (key, hyphen, rest). */
function splitKeyToken(text: string): string | undefined {
  return text.split(/\s+/).some((token) => keyOfToken(token) !== undefined) ? text : undefined;
}

function keyOfToken(token: string): { readonly key: string; readonly rest: string } | undefined {
  const [head = '', ...tail] = token.split('-');
  if (!CONNECTOR_CONTAINER_KEY.test(head)) return undefined;
  return { key: head, rest: tail.join('-') };
}

/**
 * The visible project key inside the release words, moved out of the release name. Only a token spelled exactly as a
 * visible key (upper case), alone or joined by a hyphen to the rest, and only when exactly one visible key is named and
 * a release name remains. Anything else stays as written: a key is never guessed.
 * `truncated`: the listing is partial, so unseen projects may own the other key-looking words too; the split then needs
 * exactly one key-pattern token in the whole text (visible or not), or the release text stays as written.
 */
export function splitKeyFromRelease(
  projects: readonly ConnectorItem[],
  releaseText: string,
  truncated = false,
): { readonly project: string; readonly release: string } | undefined {
  const visible = new Set(projects.map((item) => item.id));
  const tokens = releaseText.trim().split(/\s+/);
  if (truncated && tokens.filter((token) => keyOfToken(token) !== undefined).length !== 1) return undefined;
  const hits = tokens.flatMap((token, index) => {
    const parsed = keyOfToken(token);
    return parsed !== undefined && visible.has(parsed.key) ? [{ index, ...parsed }] : [];
  });
  if (new Set(hits.map((hit) => hit.key)).size !== 1 || hits.length !== 1) return undefined;
  const hit = hits[0]!;
  const rest = tokens.flatMap((token, index) => (index === hit.index ? (hit.rest.length > 0 ? [hit.rest] : []) : [token]));
  const release = rest.join(' ').trim();
  return release.length > 0 ? { project: hit.key, release } : undefined;
}

/**
 * A release that starts with the project the selector already named ("OP26" + "OP26 20261015"): the repeated key is
 * dropped, but only when the project is a visible key spelled exactly as the first release token and a name remains.
 * A different key, or a project that is not a visible key, leaves the release as written.
 */
export function stripRedundantProjectKey(projects: readonly ConnectorItem[], project: string, releaseText: string): string | undefined {
  const [first, ...rest] = releaseText.trim().split(/\s+/);
  if (first === undefined || rest.length === 0 || project.trim() !== first || !projects.some((item) => item.id === first)) return undefined;
  return rest.join(' ');
}

/**
 * The one project whose full name (letters and digits only) is exactly the owner's project words followed by their
 * release words, and longer than the project words alone, on a complete listing: "차란차 운영" + "2026" names
 * "차란차 운영 2026". Containment either way never counts ("Mobile App" + "9.9.9" does not name "Mobile App"). Several or
 * none, or no complete listing: undefined (nothing is guessed).
 */
export function projectWithReleaseWords(projects: readonly ConnectorItem[] | undefined, projectText: string | undefined, releaseText: string): ConnectorItem | undefined {
  if (projects === undefined || projectText === undefined || releaseText.trim().length === 0) return undefined;
  const alone = compact(projectText);
  const joined = compact(`${projectText} ${releaseText}`);
  if (joined.length <= alone.length) return undefined;
  const matches = projects.filter((item) => compact(item.title) === joined);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The near-match answer (owner decision B): one project to confirm, several to ask about, or none. */
type NearProject =
  | { readonly kind: 'confirm'; readonly project: ConnectorItem; readonly release?: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ConnectorItem[] }
  | { readonly kind: 'none' };

/**
 * Owner decision B (2026-10-22): the owner's project words named no visible project as written. On the COMPLETE listing,
 * by structure only (whole words of a longer name, else a small edit distance; no word list, no project specifics):
 *  1. `nearByWords`: the projects holding all of the owner's project words; with release words, the one of them proven to
 *     hold the release is confirmed with it;
 *  2. otherwise the project words with the release words joined, when exactly one visible project is near them and the
 *     release is not seen in another near project on the pages read (the selector split a word of the name off as a
 *     release: "차란차 운영" + "2026"): confirmed, then its release list. Also when the narrowing is unproven (a project
 *     with a partial version page, live 2026-10-22): the owner is asked either way. Over the bound (more than
 *     DISAMBIGUATE_MAX near projects) no version page is read and this check is by names only;
 *  3. otherwise one near project is confirmed (with the owner's release words), several are asked about, none: not found.
 */
async function resolveNearProject(
  connector: ConnectorProvider,
  projects: readonly ConnectorItem[],
  projectText: string,
  releaseText: string | undefined,
  nearByWords: readonly ConnectorItem[],
): Promise<NearProject> {
  const near = nearByWords.length > 0 ? nearByWords : fuzzyProjects(projects, projectText);
  if (releaseText !== undefined) {
    const narrowed = near.length > 0 && near.length <= DISAMBIGUATE_MAX ? await narrowByRelease(connector, near, releaseText) : undefined;
    if (narrowed !== undefined && !narrowed.unproven && narrowed.found.length === 1) return { kind: 'confirm', project: narrowed.found[0]!.project, release: releaseText };
    // Before an unproven narrowing gives up (a partial version page proves nothing): the joined words may name one project.
    const joined = joinedNearConfirm(projects, projectText, releaseText, narrowed);
    if (joined !== undefined) return joined;
    if (narrowed !== undefined && (narrowed.unproven || narrowed.found.length > 1)) {
      return near.length === 1 ? { kind: 'confirm', project: near[0] as ConnectorItem, release: releaseText } : { kind: 'ambiguous', candidates: near };
    }
  }
  if (near.length === 1) return { kind: 'confirm', project: near[0] as ConnectorItem, ...(releaseText !== undefined ? { release: releaseText } : {}) };
  if (near.length > 1) return { kind: 'ambiguous', candidates: near };
  return { kind: 'none' };
}

/**
 * Owner decision B: the confirmation of the one visible project near the project words with the release words joined
 * ({@link nearProjectsOfJoined}), when the release is not seen in another candidate on the pages read (`narrowed.seen`:
 * every candidate whose read page had an exact or whole-word match, unique or not; a page not read, or a release past a
 * partial page, cannot be seen). `narrowed` absent (over the bound): no version page was read, names only. `within`: the
 * project must be one of these (the several-candidates path). It carries the release words only when that project's own
 * page held them uniquely (a yes then shows that release); otherwise a yes lists its releases. Several or none: undefined.
 */
function joinedNearConfirm(
  projects: readonly ConnectorItem[] | undefined,
  projectText: string,
  releaseText: string,
  narrowed: Narrowed | undefined,
  within?: readonly ConnectorItem[],
): Extract<NearProject, { kind: 'confirm' }> | undefined {
  const joined = nearProjectsOfJoined(projects, projectText, releaseText);
  if (joined.length !== 1) return undefined;
  const project = joined[0] as ConnectorItem;
  if (within !== undefined && !within.some((item) => item.id === project.id)) return undefined;
  if (narrowed !== undefined && narrowed.seen.some((item) => item.id !== project.id)) return undefined;
  const held = narrowed?.found.some((hit) => hit.project.id === project.id) === true;
  return { kind: 'confirm', project, ...(held ? { release: releaseText } : {}) };
}

/**
 * The visible projects near the owner's project words with their release words joined (owner decision B): the joined
 * words, longer than the project words alone, spelled out by a name (exact or inside it, letters and digits only, never
 * cutting a digit run: "Mobile App" + "20" is not inside "… 2026"), or all of them whole words of the name. No edit
 * distance here (release words are free text: "Mobile App 9.9.9" is not a typo of "Mobile App Dev"), and a name merely
 * inside the joined words never counts. No complete listing: none.
 */
export function nearProjectsOfJoined(projects: readonly ConnectorItem[] | undefined, projectText: string, releaseText: string): ConnectorItem[] {
  if (projects === undefined || releaseText.trim().length === 0) return [];
  const joinedText = `${projectText} ${releaseText}`;
  const joined = compact(withoutWords(joinedText, PROJECT_WORDS) || joinedText);
  if (joined.length <= compact(projectText).length) return [];
  const spelled = projects.filter((item) => containsWholeDigitRuns(compact(item.title), joined));
  if (spelled.length > 0) return spelled;
  const words = tokens(withoutWords(joinedText, PROJECT_WORDS) || joinedText);
  const byWords = projects.filter((item) => words.length > 0 && words.every((word) => tokens(item.title).includes(word)));
  return byWords;
}

/**
 * The visible projects whose name (letters and digits only) is within a small edit distance of the owner's words: the
 * digit runs (a year, a version) must be equal, in order (CA review W1: "… 2025" never offers "… 2026"), and the distance
 * is counted over the other characters only, at most one edit per four of them (four at least); the closest only (a tie:
 * all of them).
 */
export function fuzzyProjects(projects: readonly ConnectorItem[], text: string): ConnectorItem[] {
  const wanted = compact(withoutWords(text, PROJECT_WORDS) || text);
  const digitRuns = (value: string): string => JSON.stringify(value.match(/\p{N}+/gu) ?? []);
  const letters = (value: string): string => value.replace(/\p{N}+/gu, '');
  const allowed = Math.floor(Array.from(letters(wanted)).length / 4);
  if (allowed < 1) return [];
  const scored = projects
    .filter((item) => digitRuns(compact(item.title)) === digitRuns(wanted))
    .map((item) => ({ item, distance: editDistance(letters(wanted), letters(compact(item.title)), allowed) }))
    .filter((entry) => entry.distance <= allowed);
  if (scored.length === 0) return [];
  const best = Math.min(...scored.map((entry) => entry.distance));
  return scored.filter((entry) => entry.distance === best).map((entry) => entry.item);
}

/** Whether `needle` occurs in `haystack` without a digit run of either cut at the match edges ("20" never in "2026"). */
function containsWholeDigitRuns(haystack: string, needle: string): boolean {
  const digit = /\p{N}/u;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    const cutsBefore = at > 0 && digit.test(haystack[at - 1] as string) && digit.test(needle[0] as string);
    const cutsAfter = end < haystack.length && digit.test(haystack[end] as string) && digit.test(needle[needle.length - 1] as string);
    if (!cutsBefore && !cutsAfter) return true;
  }
  return false;
}

/** Levenshtein distance over code points, `bound + 1` as soon as it is certainly above `bound`. */
function editDistance(left: string, right: string, bound: number): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > bound) return bound + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > bound) return bound + 1;
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * The confirmation of a near project (owner decision B). In a channel only a named release may be confirmed there (its
 * own items answer in a channel); a project's release list stays DM-only (A8 owner decision 7).
 */
function confirmBody(project: ConnectorItem, release: string | undefined, inChannel: boolean): ReleaseLookupResult {
  if (inChannel && release === undefined) return body(renderReleaseDmOnly('list'));
  return { kind: 'body', body: renderProjectConfirm(refOf(project), release), confirm: { project: project.id, ...(release !== undefined ? { release } : {}) } };
}

/** The project to name in a not-found answer: a link's key or a key-shaped owner value (never a guessed name). */
function namedProject(command: ReleaseLookupCommand, onSite: JiraReleaseLink | undefined): ReleaseProjectRef | undefined {
  if (onSite !== undefined) return { key: onSite.projectKey };
  return command.project !== undefined && CONNECTOR_CONTAINER_KEY.test(command.project.trim().toUpperCase()) ? { key: command.project.trim().toUpperCase() } : undefined;
}

function body(value: MessageBody): ReleaseLookupResult {
  return { kind: 'body', body: value };
}

/** A reply about one resolved visible project (its key). */
function resolvedBody(value: MessageBody, project: string): ReleaseLookupResult {
  return { kind: 'body', body: value, resolvedProject: project };
}

function itemsOf(result: ConnectorResult): readonly ConnectorItem[] {
  return Array.isArray(result.items) ? result.items : [];
}

function refOf(item: ConnectorItem): ReleaseProjectRef {
  return { key: item.id, ...(item.title !== item.id ? { name: item.title } : {}) };
}

async function releasesOf(connector: ConnectorProvider, key: string, limit?: number): Promise<{ readonly items: readonly ConnectorItem[]; readonly truncated?: boolean }> {
  const result = await connector.query({ query: ConnectorQueryName.RELEASES, params: { container: key, ...(limit !== undefined ? { limit } : {}) } });
  return { items: itemsOf(result), ...(result.truncated === true ? { truncated: true } : {}) };
}

/**
 * The release narrowing of several candidates. `found`: the unique hits; `unproven`: some listing was partial or held
 * several matches, so a single hit is not proven unique and nothing may be picked; `seen`: every candidate whose read page
 * had an exact or whole-word match, unique or not (Codex P2 / CA W1, 2026-10-22).
 */
interface Narrowed {
  readonly found: ReadonlyArray<{ readonly project: ConnectorItem; readonly release: ConnectorItem }>;
  readonly unproven: boolean;
  readonly seen: readonly ConnectorItem[];
}

/** The ambiguous projects that hold a release of the owner's name (each listing read once, first page only, read-only). */
async function narrowByRelease(connector: ConnectorProvider, candidates: readonly ConnectorItem[], releaseText: string): Promise<Narrowed> {
  const found: Array<{ readonly project: ConnectorItem; readonly release: ConnectorItem }> = [];
  const seen: ConnectorItem[] = [];
  let unproven = false;
  for (const candidate of candidates) {
    const known = await releasesOf(connector, candidate.id, DISAMBIGUATE_PAGE);
    const partial = known.truncated === true || known.items.length >= DISAMBIGUATE_PAGE;
    const resolved = resolveRelease(known.items, releaseText, partial);
    if (resolved.item !== undefined) found.push({ project: candidate, release: resolved.item });
    // An exact or whole-word match on the page read, unique or not (`ambiguous` is only ever set by a match).
    if (resolved.item !== undefined || resolved.ambiguous) seen.push(candidate);
    // Several matches, a hit on a partial page, or no hit on a partial page (it may sit past the page).
    if (resolved.ambiguous || (partial && resolved.item === undefined)) unproven = true;
  }
  return { found, unproven, seen };
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

/** Letter-and-digit tokens; a dotted version stays one token ("배포일_20261015(목)" → 배포일, 20261015, 목; "1.2.3" → 1.2.3). */
function tokens(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}.]+/u)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length > 0);
}

/** Whether `needle` occurs as a contiguous run of whole tokens in `haystack`. */
function containsTokens(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true;
  }
  return false;
}

/**
 * Projects matching the owner's words: an exact key, else an exact name (letters and digits only), else every project
 * whose name contains the words, or (a name of at least 3 characters) is contained in them, else every project whose
 * name has all of the owner's words as whole words ("차란차 운영 2026" ⊂ "차란차 플랫폼 운영 2026", live probe 2026-10-15).
 */
export function matchProjects(items: readonly ConnectorItem[], text: string): ConnectorItem[] {
  return matchProjectsTiered(items, text).items;
}

/**
 * {@link matchProjects} with the tier that matched: `key`, `name` (exact) and `contained` name what the owner wrote;
 * `words` (all of the owner's words as whole words of a longer name) is only a near match (owner decision B, 2026-10-22).
 */
export function matchProjectsTiered(items: readonly ConnectorItem[], text: string): { readonly items: ConnectorItem[]; readonly tier: 'key' | 'name' | 'contained' | 'words' | 'none' } {
  const key = text.trim().toUpperCase();
  if (CONNECTOR_CONTAINER_KEY.test(key)) {
    const byKey = items.filter((item) => item.id === key);
    if (byKey.length > 0) return { items: byKey, tier: 'key' };
  }
  const stripped = withoutWords(text, PROJECT_WORDS);
  const source = stripped.length > 0 ? stripped : text;
  const wanted = compact(source);
  if (wanted.length === 0) return { items: [], tier: 'none' };
  const exact = items.filter((item) => compact(item.title) === wanted);
  if (exact.length > 0) return { items: exact, tier: 'name' };
  const contained = items.filter((item) => {
    const name = compact(item.title);
    return name.length > 0 && (name.includes(wanted) || (name.length >= 3 && wanted.includes(name)));
  });
  if (contained.length > 0) return { items: contained, tier: 'contained' };
  const words = tokens(source);
  const byWords = items.filter((item) => {
    const name = tokens(item.title);
    return words.length > 0 && words.every((word) => name.includes(word));
  });
  return { items: byWords, tier: byWords.length > 0 ? 'words' : 'none' };
}

/**
 * The release named by the owner's words: exact (case and spacing aside), else without the closed release words, else
 * the one release whose name holds those words as whole tokens ("20261015" in "배포일_20261015(목)"). Two such releases:
 * none (the owner gets the nearby names), never a guess.
 */
export function matchRelease(items: readonly ConnectorItem[], text: string): ConnectorItem | undefined {
  return resolveRelease(items, text, false).item;
}

/**
 * Like matchRelease, but says when several releases hold the words (`ambiguous`), and on a partial listing a whole-token
 * hit is not proven unique, so it is not returned (an exact name is unique in a project and still counts).
 */
function resolveRelease(items: readonly ConnectorItem[], text: string, partial: boolean): { readonly item?: ConnectorItem; readonly ambiguous: boolean } {
  const wanted = fold(text);
  const exact = items.find((item) => fold(item.title) === wanted);
  if (exact !== undefined) return { item: exact, ambiguous: false };
  const stripped = withoutWords(text, RELEASE_WORDS);
  if (stripped.length > 0 && stripped !== wanted) {
    const byStripped = items.find((item) => fold(item.title) === stripped);
    if (byStripped !== undefined) return { item: byStripped, ambiguous: false };
  }
  const words = tokens(stripped.length > 0 ? stripped : text);
  const byTokens = items.filter((item) => containsTokens(tokens(item.title), words));
  if (byTokens.length > 1) return { ambiguous: true };
  if (byTokens.length === 1) return partial ? { ambiguous: true } : { item: byTokens[0] as ConnectorItem, ambiguous: false };
  return { ambiguous: false };
}

/**
 * Up to five release names closest to the owner's words: the longest common prefix with the words or any token of the
 * name first ("20261016" is close to "배포일_20261015(목)"), then Jira's order.
 */
export function nearbyReleases(items: readonly ConnectorItem[], text: string): ConnectorItem[] {
  const wanted = withoutWords(text, RELEASE_WORDS) || fold(text);
  const prefix = (a: string, b: string): number => {
    const x = Array.from(a);
    const y = Array.from(b);
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
    return n;
  };
  const score = (name: string): number => Math.max(prefix(fold(name), wanted), ...tokens(name).map((token) => prefix(token, wanted)));
  return items
    .map((item, index) => ({ item, index, score: score(item.title) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 5)
    .map((entry) => entry.item);
}

/** The connector with a deadline check before every query (the deadline cannot cancel a request already sent). */
function guarded(connector: ConnectorProvider, signal: AbortSignal | undefined): ConnectorProvider {
  if (signal === undefined) return connector;
  return {
    source: connector.source,
    readOnly: connector.readOnly,
    isAvailable: () => connector.isAvailable(),
    query: async (query) => {
      if (signal.aborted) throw new ReleaseLookupAborted();
      return connector.query(query);
    },
  };
}

/** The owner's release words without the closed release words, case kept ("20261015 배포건" → "20261015"). */
export function stripReleaseWords(text: string): string {
  let out = ` ${text.normalize('NFC').replace(/\s+/g, ' ').trim()} `;
  for (const word of [...RELEASE_WORDS].sort((a, b) => b.length - a.length)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<=[\\s\\p{N}])${escaped}(?=\\s)`, 'giu'), ' ');
  }
  const stripped = out.replace(/\s+/g, ' ').trim();
  return stripped.length > 0 ? stripped : text.trim();
}

import type { MessageBody } from '../../domain';
import { CONNECTOR_CONTAINER_KEY, CONNECTOR_QUERY_MAX_LIMIT, ConnectorQueryName, isConnectorQueryError } from '../../ports';
import type { ConnectorItem, ConnectorProvider, ConnectorQueryErrorReason, ConnectorResult } from '../../ports';
import { releaseLinkOnSite, type JiraReleaseLink } from './jira-release-link';
import {
  renderProjectAmbiguous,
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
      const candidates = matchProjects(itemsOf(listed), command.project);
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
          return body(renderReleaseList(refOf(joined), known.items, known.truncated === true, ignoredLink));
        }
        if (narrowed === undefined || narrowed.unproven || narrowed.found.length !== 1) {
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
            if (match === undefined) return body(renderReleaseNotFound(keyedRelease, project, input.inChannel === true ? [] : nearbyReleases(known.items, keyedRelease)));
          } else {
            const resolved = resolveRelease(known.items, command.release, truncated);
            match = resolved.item;
            // The selector split the project's own trailing word off as a release ("차란차 운영" + "2026" for the project
            // "차란차 운영 2026"): no such release on a complete listing, and the two values together name exactly this
            // project, so the owner named the project alone: its release list (DM-only, like any list).
            if (match === undefined && !truncated && !resolved.ambiguous && projectWithReleaseWords(completeProjects, command.project, command.release)?.id === project.key) {
              return body(input.inChannel === true ? renderReleaseDmOnly('list') : renderReleaseList(project, known.items, false, ignoredLink));
            }
          }
          if (match === undefined) return body(renderReleaseNotFound(command.release, project, input.inChannel === true ? [] : nearbyReleases(known.items, command.release)));
        }
        release = { id: match.id, name: match.title, ...(match.url !== undefined ? { url: match.url } : {}) };
      } else {
        // The closed release words are not part of a version name ("20261015 배포건" → 20261015).
        release = { name: stripReleaseWords(command.release), ...(stripReleaseWords(command.release) !== command.release.trim() ? { raw: command.release.trim() } : {}) };
      }
    } else if (project !== undefined) {
      const known = await releasesOf(connector, project.key);
      return body(renderReleaseList(project, known.items, known.truncated === true, ignoredLink));
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

async function releasesOf(connector: ConnectorProvider, key: string, limit?: number): Promise<{ readonly items: readonly ConnectorItem[]; readonly truncated?: boolean }> {
  const result = await connector.query({ query: ConnectorQueryName.RELEASES, params: { container: key, ...(limit !== undefined ? { limit } : {}) } });
  return { items: itemsOf(result), ...(result.truncated === true ? { truncated: true } : {}) };
}

/**
 * The ambiguous projects that hold a release of the owner's name (each listing read once, read-only). `unproven`: some
 * listing was partial or held several matches, so a single hit is not proven unique and nothing may be picked.
 */
async function narrowByRelease(
  connector: ConnectorProvider,
  candidates: readonly ConnectorItem[],
  releaseText: string,
): Promise<{ readonly found: Array<{ readonly project: ConnectorItem; readonly release: ConnectorItem }>; readonly unproven: boolean }> {
  const found: Array<{ readonly project: ConnectorItem; readonly release: ConnectorItem }> = [];
  let unproven = false;
  for (const candidate of candidates) {
    const known = await releasesOf(connector, candidate.id, DISAMBIGUATE_PAGE);
    const partial = known.truncated === true || known.items.length >= DISAMBIGUATE_PAGE;
    const resolved = resolveRelease(known.items, releaseText, partial);
    if (resolved.item !== undefined) found.push({ project: candidate, release: resolved.item });
    // Several matches, a hit on a partial page, or no hit on a partial page (it may sit past the page).
    if (resolved.ambiguous || (partial && resolved.item === undefined)) unproven = true;
  }
  return { found, unproven };
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
  const key = text.trim().toUpperCase();
  if (CONNECTOR_CONTAINER_KEY.test(key)) {
    const byKey = items.filter((item) => item.id === key);
    if (byKey.length > 0) return byKey;
  }
  const stripped = withoutWords(text, PROJECT_WORDS);
  const source = stripped.length > 0 ? stripped : text;
  const wanted = compact(source);
  if (wanted.length === 0) return [];
  const exact = items.filter((item) => compact(item.title) === wanted);
  if (exact.length > 0) return exact;
  const contained = items.filter((item) => {
    const name = compact(item.title);
    return name.length > 0 && (name.includes(wanted) || (name.length >= 3 && wanted.includes(name)));
  });
  if (contained.length > 0) return contained;
  const words = tokens(source);
  return items.filter((item) => {
    const name = tokens(item.title);
    return words.length > 0 && words.every((word) => name.includes(word));
  });
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

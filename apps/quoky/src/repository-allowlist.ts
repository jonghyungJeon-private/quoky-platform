import { isSafeRepoName, isSafeRepoOwner } from '@quoky/core';
import type { RepositoryIdentity, WorkspaceRepositoryResolution } from '@quoky/core';

/**
 * Multi-repository allowlist for code work (ADR-0109 D1/D2) — composition-root only.
 *
 * The allowlist is the validated `QUOKY_GITHUB_REPOS` (or the legacy `QUOKY_GITHUB_OWNER`/`QUOKY_GITHUB_REPO` pair as an
 * allowlist of one). A registered project's repository identity is never configured per project: it is derived from
 * the workspace `origin` URLs on every use and must name exactly one allowlisted repository. Nothing here reads git,
 * the network or a credential; the URL parser is pure and strict (HTTPS github.com, plain `/<owner>/<repo>[.git]`).
 */

/** At most this many allowlisted repositories (ADR-0109 D1). */
export const MAX_GITHUB_REPOSITORIES = 10;

/** The exact prefix every accepted remote URL must start with: HTTPS, lower-case github.com, no userinfo, no port. */
const GITHUB_HTTPS_PREFIX = 'https://github.com/';

function keyOf(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * The validated allowlist. Lookups are case-insensitive (GitHub owner and repository names are), and a match returns
 * the allowlist's own spelling so every step binds one canonical identity.
 */
export class RepositoryAllowlist {
  private readonly byKey = new Map<string, RepositoryIdentity>();

  constructor(entries: readonly RepositoryIdentity[]) {
    for (const entry of entries) {
      const key = keyOf(entry.owner, entry.repo);
      if (!this.byKey.has(key)) this.byKey.set(key, { provider: 'github', owner: entry.owner, repo: entry.repo });
    }
  }

  /** The allowlisted identities in configuration order. */
  get entries(): readonly RepositoryIdentity[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }

  /** The allowlisted entry for `owner/repo` (case-insensitive), or `undefined`. */
  find(identity: { owner: string; repo: string }): RepositoryIdentity | undefined {
    const entry = this.byKey.get(keyOf(identity.owner, identity.repo));
    return entry ? { ...entry } : undefined;
  }

  has(identity: { owner: string; repo: string }): boolean {
    return this.byKey.has(keyOf(identity.owner, identity.repo));
  }
}

/** Parse one allowlist entry (`owner/repo`, exactly one slash, safe owner and name). `null` when malformed. */
export function parseRepositoryEntry(entry: string): RepositoryIdentity | null {
  const parts = entry.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!isSafeRepoOwner(owner) || !isSafeRepoName(repo)) return null;
  return { provider: 'github', owner, repo };
}

/**
 * The `owner/repo` a single remote URL names, or `null` when it is not a plain HTTPS github.com repository URL.
 * Accepted: `https://github.com/<owner>/<repo>`, optionally with `.git` and/or one trailing `/`. Refused: SSH or
 * scp-like, any other scheme or host (including upper-case or a port), userinfo/credentials, a query or fragment,
 * percent-encoding, dot segments, or extra path segments. The parsed URL must round-trip to the raw text, so a
 * normalization difference between this parser and git is refused rather than guessed.
 */
export function githubRepositoryFromRemoteUrl(url: string): RepositoryIdentity | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (raw.length === 0 || raw.length > 300 || !raw.startsWith(GITHUB_HTTPS_PREFIX)) return null;
  if (/[\s%?#@\\]/.test(raw) || hasControlChar(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  const rawPath = raw.slice(GITHUB_HTTPS_PREFIX.length);
  if (`/${rawPath}` !== parsed.pathname) return null; // dot segments or any other normalization → refused
  const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const segments = path.split('/');
  if (segments.length !== 2) return null;
  const owner = segments[0]!;
  const withSuffix = segments[1]!;
  const repo = withSuffix.toLowerCase().endsWith('.git') ? withSuffix.slice(0, -4) : withSuffix;
  if (!isSafeRepoOwner(owner) || !isSafeRepoName(repo)) return null;
  return { provider: 'github', owner, repo };
}

/**
 * Resolve the single repository a set of remote URLs names (ADR-0109 D2). Every URL must parse
 * (`unsupported-remote` otherwise), all must name the same repository (`ambiguous` otherwise: one project, two
 * repositories), and that repository must be allowlisted (`not-allowlisted`). The result carries the allowlist's
 * canonical spelling and never a URL.
 */
export function resolveRepositoryFromRemoteUrls(
  urls: readonly string[],
  allowlist: RepositoryAllowlist,
): WorkspaceRepositoryResolution {
  if (urls.length === 0) return { status: 'refused', reason: 'unsupported-remote' };
  const identities: RepositoryIdentity[] = [];
  for (const url of urls) {
    const identity = githubRepositoryFromRemoteUrl(url);
    if (!identity) return { status: 'refused', reason: 'unsupported-remote' };
    identities.push(identity);
  }
  const keys = new Set(identities.map((identity) => keyOf(identity.owner, identity.repo)));
  if (keys.size !== 1) return { status: 'refused', reason: 'ambiguous' };
  const entry = allowlist.find(identities[0]!);
  if (!entry) return { status: 'refused', reason: 'not-allowlisted' };
  return { status: 'resolved', identity: entry };
}

function hasControlChar(s: string): boolean {
  return [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
}

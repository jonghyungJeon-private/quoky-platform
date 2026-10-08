import type { RepositoryIdentity } from '@quoky/core';
import type { GitHubStatusReadToken } from '@quoky/repository-hosting-github';
import type { RepositoryAllowlist } from './repository-allowlist';

type Permissions = Record<string, 'read' | 'write'>;

/** The slice of `GitHubAppAuth` the token sources use (injectable so tests count mints without any network). */
export interface GitHubAppTokenMinter {
  resolveInstallationId(owner: string, repo: string): Promise<number | null>;
  /** The installation's account login via the App JWT, or null when the installation does not exist. */
  getInstallationAccountLogin(installationId: number): Promise<string | null>;
  tokenForRepository(installationId: number, owner: string, repo: string, permissions?: Permissions): Promise<string>;
  tokenForInstallation(installationId: number, scope?: { permissions?: Permissions }): Promise<string>;
}

export interface GitHubAppTokenSourcesDeps {
  minter: GitHubAppTokenMinter;
  allowlist: RepositoryAllowlist;
  /**
   * Explicit `QUOKY_GITHUB_APP_INSTALLATION_ID`. It is used for a repository only after the App JWT lookups confirm
   * that the installation's account is the repository owner and that the repository's installation IS this id;
   * otherwise the installation is resolved per repository.
   */
  installationId?: number;
  /** Builds the PR-status source (the hosting adapter's `createPullRequestStatusTokenSource`). */
  createStatusTokenSource: (
    mint: (permissions: Permissions, identity: RepositoryIdentity) => Promise<string>,
  ) => (identity: RepositoryIdentity) => Promise<GitHubStatusReadToken>;
}

export interface GitHubAppTokenSources {
  /** contents + pull_requests write, down-scoped to exactly `identity` (git push/ls-remote/main sync, PR create/merge). */
  tokenSource: (identity: RepositoryIdentity) => Promise<string>;
  /** Read-only PR status token, down-scoped to exactly `identity`. */
  statusTokenSource: (identity: RepositoryIdentity) => Promise<GitHubStatusReadToken>;
  /** Personal Work connector discovery (issues/pull_requests read) — unchanged ADR-0061 installation token. */
  readTokenSource: () => Promise<string>;
}

/** The fixed refusal when the explicit installation id does not belong to the repository. Never echoes an id. */
export const EXPLICIT_INSTALLATION_MISMATCH =
  'github app: the configured installation id is not the installation of this repository owner; no token minted';

/** The fixed refusal when an identity reaches a token source without being allowlisted. Never echoes the identity. */
export const NOT_ALLOWLISTED_MINT_REFUSAL = 'github app: repository is not on the allowlist; no token minted';

/**
 * GitHub App token sources for a repository allowlist (ADR-0109 D3). Every repository-scoped token is minted by
 * `tokenForRepository` for exactly the one identity the call names, and only after that identity is found on the
 * allowlist — a non-allowlisted identity throws before any installation lookup or mint (defence in depth behind the
 * runtime and git-preflight refusals). The installation id is the explicit configured one, or resolved and cached per
 * repository. Tokens stay adapter-local: these closures return them only to the hosting adapter / git decorator.
 */
export function createGitHubAppTokenSources(deps: GitHubAppTokenSourcesDeps): GitHubAppTokenSources {
  const installationIds = new Map<string, number>();
  const allowlisted = (identity: RepositoryIdentity): RepositoryIdentity => {
    const entry = deps.allowlist.find(identity);
    if (!entry) throw new Error(NOT_ALLOWLISTED_MINT_REFUSAL);
    return entry;
  };
  const installationIdFor = async (identity: RepositoryIdentity): Promise<number> => {
    const key = `${identity.owner}/${identity.repo}`;
    const cached = installationIds.get(key);
    if (cached !== undefined) return cached;
    // App-JWT lookups only (no installation token): the repository's installation …
    const resolved = await deps.minter.resolveInstallationId(identity.owner, identity.repo);
    if (resolved === null) throw new Error('github app: not installed on the configured repository');
    if (deps.installationId !== undefined) {
      // … must BE the explicitly configured installation, whose account must be the repository owner (ADR-0109
      // review P2: an explicit id never mints a bootstrap or repository token for another owner's installation).
      if (resolved !== deps.installationId) throw new Error(EXPLICIT_INSTALLATION_MISMATCH);
      const login = await deps.minter.getInstallationAccountLogin(deps.installationId);
      if (login === null || login.toLowerCase() !== identity.owner.toLowerCase()) {
        throw new Error(EXPLICIT_INSTALLATION_MISMATCH);
      }
    }
    installationIds.set(key, resolved);
    return resolved;
  };
  const mintFor = async (identity: RepositoryIdentity, permissions: Permissions): Promise<string> => {
    const target = allowlisted(identity);
    return deps.minter.tokenForRepository(await installationIdFor(target), target.owner, target.repo, permissions);
  };
  return {
    tokenSource: (identity) => mintFor(identity, { contents: 'write', pull_requests: 'write' }),
    statusTokenSource: deps.createStatusTokenSource((permissions, identity) => mintFor(identity, permissions)),
    readTokenSource: async () => {
      const first = deps.allowlist.entries[0];
      if (!first) throw new Error('github app: no repository configured');
      return deps.minter.tokenForInstallation(await installationIdFor(first), {
        permissions: { issues: 'read', pull_requests: 'read' },
      });
    },
  };
}

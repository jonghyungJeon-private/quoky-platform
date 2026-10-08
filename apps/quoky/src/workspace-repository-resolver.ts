import type { WorkspaceRepositoryResolution } from '@quoky/core';
import { defaultReadRemoteUrl, sanitizedGitConfigEnv } from './github-app-git-provider';
import type { RemoteDirection } from './github-app-git-provider';
import { resolveRepositoryFromRemoteUrls } from './repository-allowlist';
import type { RepositoryAllowlist } from './repository-allowlist';

/** The remote a registered project's repository identity is read from (ADR-0109 D2). */
export const PROJECT_IDENTITY_REMOTE = 'origin';

export interface WorkspaceRepositoryIdentityResolverDeps {
  allowlist: RepositoryAllowlist;
  /**
   * Credential-free local read of the remote's URLs (no network, no askpass). Injectable for tests; the default is
   * the same `git remote get-url --all` + `--push --all` read the App-auth git preflight uses.
   */
  readRemoteUrl?: (
    rootPath: string,
    remote: string,
    env: NodeJS.ProcessEnv,
    direction: RemoteDirection,
  ) => string | readonly string[];
  /** The environment the sanitized git env is derived from (default `process.env`). */
  env?: () => NodeJS.ProcessEnv;
}

/**
 * Resolves a registered project's repository identity from its workspace `origin` fetch AND push URLs (ADR-0109 D2),
 * read under the ADR-0061 sanitized git environment so an inherited `GIT_CONFIG_PARAMETERS` rewrite cannot make the
 * read differ from what the credentialed push sees. HTTPS github.com only; one project names one allowlisted
 * repository. Derived on every call (nothing stored), never throws, never returns a URL: an unreadable remote is
 * `unsupported-remote`. This is the composition root's `repositoryHosting.resolveIdentity`.
 */
export class WorkspaceRepositoryIdentityResolver {
  private readonly readRemoteUrl: NonNullable<WorkspaceRepositoryIdentityResolverDeps['readRemoteUrl']>;
  private readonly env: () => NodeJS.ProcessEnv;

  constructor(private readonly deps: WorkspaceRepositoryIdentityResolverDeps) {
    this.readRemoteUrl = deps.readRemoteUrl ?? defaultReadRemoteUrl;
    this.env = deps.env ?? (() => process.env);
  }

  async resolve(rootPath: string): Promise<WorkspaceRepositoryResolution> {
    let urls: readonly string[];
    try {
      const read = this.readRemoteUrl(rootPath, PROJECT_IDENTITY_REMOTE, sanitizedGitConfigEnv(this.env()), 'push');
      urls = typeof read === 'string' ? [read] : read;
    } catch {
      return { status: 'refused', reason: 'unsupported-remote' };
    }
    return resolveRepositoryFromRemoteUrls(urls, this.deps.allowlist);
  }
}

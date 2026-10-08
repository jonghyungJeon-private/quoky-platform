import type { WorkspaceRepositoryResolution } from '@quoky/core';
import { defaultReadRemoteUrl, sanitizedGitConfigEnv } from './github-app-git-provider';
import type { RemoteDirection } from './github-app-git-provider';
import { isSafeRemoteName, resolveRepositoryFromRemoteUrls, withRefusalHint } from './repository-allowlist';
import type { RepositoryAllowlist } from './repository-allowlist';

/** The remote a registered project's repository identity is read from (ADR-0109 D2). */
export const PROJECT_IDENTITY_REMOTE = 'origin';

export interface WorkspaceRepositoryIdentityResolverDeps {
  allowlist: RepositoryAllowlist;
  /**
   * Credential-free local read of the remote's URLs (no network, no askpass). Injectable for tests; the default is
   * the same `git remote get-url --all` + `--push --all` read the remote-bound git provider uses.
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
 * Resolves a registered project's repository identity (ADR-0109 D2) from its workspace `origin` fetch AND push URLs
 * and, when a step will use another remote (a push to an upstream's remote), that remote's fetch and push URLs too —
 * all must name ONE allowlisted repository. Read under the ADR-0061 sanitized git environment (inherited
 * `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_*` dropped), after git's own `insteadOf` / `pushInsteadOf` expansion, so the
 * read sees what the bound push sees. HTTPS github.com only. Derived on every call (nothing stored), never throws,
 * never returns a URL: an unreadable remote is `unsupported-remote`. A refusal carries a fixed operator hint. This is
 * the composition root's `repositoryHosting.resolveIdentity`.
 */
export class WorkspaceRepositoryIdentityResolver {
  private readonly readRemoteUrl: NonNullable<WorkspaceRepositoryIdentityResolverDeps['readRemoteUrl']>;
  private readonly env: () => NodeJS.ProcessEnv;

  constructor(private readonly deps: WorkspaceRepositoryIdentityResolverDeps) {
    this.readRemoteUrl = deps.readRemoteUrl ?? defaultReadRemoteUrl;
    this.env = deps.env ?? (() => process.env);
  }

  async resolve(rootPath: string, remote: string = PROJECT_IDENTITY_REMOTE): Promise<WorkspaceRepositoryResolution> {
    if (!isSafeRemoteName(remote)) return withRefusalHint({ status: 'refused', reason: 'unsupported-remote' });
    const remotes = remote === PROJECT_IDENTITY_REMOTE ? [PROJECT_IDENTITY_REMOTE] : [PROJECT_IDENTITY_REMOTE, remote];
    const env = sanitizedGitConfigEnv(this.env());
    const urls: string[] = [];
    try {
      for (const name of remotes) {
        const read = this.readRemoteUrl(rootPath, name, env, 'push');
        urls.push(...(typeof read === 'string' ? [read] : read));
      }
    } catch {
      return withRefusalHint({ status: 'refused', reason: 'unsupported-remote' });
    }
    return withRefusalHint(resolveRepositoryFromRemoteUrls(urls, this.deps.allowlist));
  }
}

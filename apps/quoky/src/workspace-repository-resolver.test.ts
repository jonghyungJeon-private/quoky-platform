import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryIdentity } from '@quoky/core';
import { RepositoryAllowlist } from './repository-allowlist';
import { WorkspaceRepositoryIdentityResolver } from './workspace-repository-resolver';

/**
 * ADR-0109 D2 — a registered project's identity from its workspace `origin`, read with REAL local git (no network)
 * under the ADR-0061 sanitized git environment.
 */
const WIDGETS: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'widgets' };
const GADGETS: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'gadgets' };
const allowlist = new RepositoryAllowlist([WIDGETS, GADGETS]);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Isolated git (no global/system config) so the host's own git config cannot affect the reads. */
const isolated = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
});

function repo(setup: (git: (...args: string[]) => void) => void): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-ws-identity-'));
  dirs.push(dir);
  const env = isolated(dir);
  const git = (...args: string[]) => {
    execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' });
  };
  git('init', '-q');
  setup(git);
  return { dir, env };
}

function resolverFor(env: NodeJS.ProcessEnv): WorkspaceRepositoryIdentityResolver {
  return new WorkspaceRepositoryIdentityResolver({ allowlist, env: () => env });
}

describe('WorkspaceRepositoryIdentityResolver (ADR-0109 D2, real local git)', () => {
  it('an HTTPS github.com origin on the allowlist resolves to that identity', async () => {
    const r = repo((git) => git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git'));
    await expect(resolverFor(r.env).resolve(r.dir)).resolves.toEqual({ status: 'resolved', identity: WIDGETS });
  });

  it('two projects whose origins name the same repository both resolve to it', async () => {
    const a = repo((git) => git('remote', 'add', 'origin', 'https://github.com/acme/gadgets.git'));
    const b = repo((git) => git('remote', 'add', 'origin', 'https://github.com/acme/gadgets'));
    await expect(resolverFor(a.env).resolve(a.dir)).resolves.toEqual({ status: 'resolved', identity: GADGETS });
    await expect(resolverFor(b.env).resolve(b.dir)).resolves.toEqual({ status: 'resolved', identity: GADGETS });
  });

  it('an origin on github.com but not on the allowlist → not-allowlisted', async () => {
    const r = repo((git) => git('remote', 'add', 'origin', 'https://github.com/acme/other.git'));
    await expect(resolverFor(r.env).resolve(r.dir)).resolves.toMatchObject({ status: 'refused', reason: 'not-allowlisted' });
  });

  it('fetch URL ≠ push URL (a pushurl to another repository, even an allowlisted one) → ambiguous', async () => {
    const r = repo((git) => {
      git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
      git('config', 'remote.origin.pushurl', 'https://github.com/acme/gadgets.git');
    });
    await expect(resolverFor(r.env).resolve(r.dir)).resolves.toMatchObject({ status: 'refused', reason: 'ambiguous' });
  });

  it('a pushurl to the same repository is fine', async () => {
    const r = repo((git) => {
      git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
      git('config', 'remote.origin.pushurl', 'https://github.com/acme/widgets');
    });
    await expect(resolverFor(r.env).resolve(r.dir)).resolves.toEqual({ status: 'resolved', identity: WIDGETS });
  });

  it('an SSH pushurl, or an insteadOf rewrite to SSH, is refused (the existing HTTPS preflight is not bypassed)', async () => {
    const sshPush = repo((git) => {
      git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
      git('config', 'remote.origin.pushurl', 'git@github.com:acme/widgets.git');
    });
    await expect(resolverFor(sshPush.env).resolve(sshPush.dir)).resolves.toMatchObject({ status: 'refused', reason: 'unsupported-remote' });
    const rewrite = repo((git) => {
      git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
      git('config', 'url.git@github.com:.insteadOf', 'https://github.com/');
    });
    await expect(resolverFor(rewrite.env).resolve(rewrite.dir)).resolves.toMatchObject({ status: 'refused', reason: 'unsupported-remote' });
  });

  it('a pushInsteadOf rewrite to another repository is refused as ambiguous', async () => {
    const r = repo((git) => {
      git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
      git('config', 'url.https://github.com/acme/gadgets.pushInsteadOf', 'https://github.com/acme/widgets');
    });
    await expect(resolverFor(r.env).resolve(r.dir)).resolves.toMatchObject({ status: 'refused', reason: 'ambiguous' });
  });

  it('an inherited GIT_CONFIG_PARAMETERS rewrite is dropped: an SSH origin stays refused', async () => {
    const r = repo((git) => git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git'));
    const env = { ...r.env, GIT_CONFIG_PARAMETERS: "'url.https://github.com/.insteadof'='git@github.com:'" };
    await expect(resolverFor(env).resolve(r.dir)).resolves.toMatchObject({ status: 'refused', reason: 'unsupported-remote' });
  });

  it.each([
    ['a non-github host', 'https://gitlab.com/acme/widgets.git'],
    ['a local path', '/tmp/origin.git'],
    ['an embedded credential', 'https://user:pw@github.com/acme/widgets.git'],
  ])('%s → unsupported-remote', async (_label, url) => {
    const r = repo((git) => git('remote', 'add', 'origin', url));
    await expect(resolverFor(r.env).resolve(r.dir)).resolves.toMatchObject({ status: 'refused', reason: 'unsupported-remote' });
  });

  it('no origin, or not a git repository at all → unsupported-remote (never throws)', async () => {
    const noOrigin = repo(() => undefined);
    await expect(resolverFor(noOrigin.env).resolve(noOrigin.dir)).resolves.toMatchObject({ status: 'refused', reason: 'unsupported-remote' });
    const plain = mkdtempSync(join(tmpdir(), 'quoky-ws-plain-'));
    dirs.push(plain);
    await expect(resolverFor(isolated(plain)).resolve(plain)).resolves.toMatchObject({ status: 'refused', reason: 'unsupported-remote' });
  });

  it('reads origin (fetch + push direction) under the sanitized env (credential helpers reset)', async () => {
    const calls: Array<{ remote: string; direction: string; helper: string | undefined }> = [];
    const resolver = new WorkspaceRepositoryIdentityResolver({
      allowlist,
      env: () => ({ PATH: '', GIT_CONFIG_PARAMETERS: 'x', GIT_CONFIG_COUNT: '9' }),
      readRemoteUrl: (_root, remote, env, direction) => {
        calls.push({ remote, direction, helper: env.GIT_CONFIG_KEY_0 });
        expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
        expect(env.GIT_CONFIG_COUNT).toBe('1');
        return ['https://github.com/acme/widgets.git', 'https://github.com/acme/widgets.git'];
      },
    });
    await expect(resolver.resolve('/any')).resolves.toEqual({ status: 'resolved', identity: WIDGETS });
    expect(calls).toEqual([{ remote: 'origin', direction: 'push', helper: 'credential.helper' }]);
  });

  it('the actual push remote (an upstream on another remote) must name the same allowlisted repository as origin', async () => {
    const r = repo((git) => {
      git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
      git('remote', 'add', 'other', 'https://github.com/other/unlisted.git');
      git('remote', 'add', 'mirror', 'https://github.com/acme/widgets');
      git('remote', 'add', 'gadgets', 'https://github.com/acme/gadgets.git');
    });
    const resolver = resolverFor(r.env);
    await expect(resolver.resolve(r.dir, 'other')).resolves.toMatchObject({ status: 'refused', reason: 'ambiguous' });
    await expect(resolver.resolve(r.dir, 'gadgets')).resolves.toMatchObject({ status: 'refused', reason: 'ambiguous' });
    await expect(resolver.resolve(r.dir, 'mirror')).resolves.toEqual({ status: 'resolved', identity: WIDGETS });
    await expect(resolver.resolve(r.dir, '--upload-pack=x')).resolves.toMatchObject({ status: 'refused', reason: 'unsupported-remote' });
    await expect(resolver.resolve(r.dir, 'missing')).resolves.toMatchObject({ status: 'refused', reason: 'unsupported-remote' });
  });

  it('a refusal carries the fixed operator hint (the GitHub/env specifics live in the composition root)', async () => {
    const r = repo((git) => git('remote', 'add', 'origin', 'https://github.com/acme/other.git'));
    const result = await resolverFor(r.env).resolve(r.dir);
    expect(result).toMatchObject({ status: 'refused', reason: 'not-allowlisted' });
    expect(result.status === 'refused' ? result.hint : '').toContain('QUOKY_GITHUB_REPOS');
    expect(JSON.stringify(result)).not.toContain('acme/other');
  });
});

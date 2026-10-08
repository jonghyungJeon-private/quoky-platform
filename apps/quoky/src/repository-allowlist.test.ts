import { describe, expect, it } from 'vitest';
import type { RepositoryIdentity } from '@quoky/core';
import {
  RepositoryAllowlist,
  githubRepositoryFromRemoteUrl,
  parseRepositoryEntry,
  resolveRepositoryFromRemoteUrls,
} from './repository-allowlist';

const WIDGETS: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'widgets' };
const GADGETS: RepositoryIdentity = { provider: 'github', owner: 'acme', repo: 'gadgets' };
const allowlist = new RepositoryAllowlist([WIDGETS, GADGETS]);

describe('parseRepositoryEntry (ADR-0109 D1)', () => {
  it('accepts a safe owner/repo', () => {
    expect(parseRepositoryEntry('acme/widgets')).toEqual(WIDGETS);
    expect(parseRepositoryEntry('my-org/repo.name_2')).toEqual({ provider: 'github', owner: 'my-org', repo: 'repo.name_2' });
  });

  it.each([
    '',
    'acme',
    'acme/',
    '/widgets',
    'acme/widgets/extra',
    'acme/widgets.git',
    'https://github.com/acme/widgets',
    'git@github.com:acme/widgets',
    'ac me/widgets',
    '-acme/widgets',
    'acme/.hidden',
    'acme/..',
    'acme/token-service',
  ])('refuses %j', (entry) => {
    expect(parseRepositoryEntry(entry)).toBeNull();
  });
});

describe('githubRepositoryFromRemoteUrl (ADR-0109 D2: HTTPS github.com only)', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'widgets'],
    ['https://github.com/acme/widgets', 'widgets'],
    ['https://github.com/acme/widgets/', 'widgets'],
    ['https://github.com/acme/widgets.git/', 'widgets'],
    ['  https://github.com/acme/widgets.git  ', 'widgets'],
  ])('parses %j', (url, repo) => {
    expect(githubRepositoryFromRemoteUrl(url)).toEqual({ provider: 'github', owner: 'acme', repo });
  });

  it.each([
    'git@github.com:acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
    'http://github.com/acme/widgets.git',
    'https://gitlab.com/acme/widgets.git',
    'https://GitHub.com/acme/widgets.git',
    'https://github.com:443/acme/widgets.git',
    'https://www.github.com/acme/widgets.git',
    'https://github.com.evil.example/acme/widgets.git',
    'https://user@github.com/acme/widgets.git',
    'https://github.com/acme/widgets.git?x=1',
    'https://github.com/acme/widgets.git#frag',
    'https://github.com/acme/wid%67ets.git',
    'https://github.com/acme/../acme/widgets.git',
    'https://github.com/acme/./widgets.git',
    'https://github.com/acme/widgets/tree/main',
    'https://github.com/acme',
    'https://github.com//widgets',
    'file:///tmp/origin.git',
    '/tmp/origin.git',
    '',
  ])('refuses %j', (url) => {
    expect(githubRepositoryFromRemoteUrl(url)).toBeNull();
  });
});

describe('resolveRepositoryFromRemoteUrls (ADR-0109 D2)', () => {
  it('resolves when every fetch and push URL names the same allowlisted repository (allowlist spelling)', () => {
    expect(
      resolveRepositoryFromRemoteUrls(['https://github.com/acme/widgets.git', 'https://github.com/ACME/Widgets'], allowlist),
    ).toEqual({ status: 'resolved', identity: WIDGETS });
  });

  it('fetch ≠ push (two repositories, both allowlisted) → ambiguous', () => {
    expect(
      resolveRepositoryFromRemoteUrls(['https://github.com/acme/widgets.git', 'https://github.com/acme/gadgets.git'], allowlist),
    ).toEqual({ status: 'refused', reason: 'ambiguous' });
  });

  it('a non-allowlisted github.com repository → not-allowlisted', () => {
    expect(resolveRepositoryFromRemoteUrls(['https://github.com/acme/other.git'], allowlist)).toEqual({
      status: 'refused',
      reason: 'not-allowlisted',
    });
  });

  it('any SSH / non-github URL among them, or no URL at all → unsupported-remote', () => {
    for (const urls of [
      ['https://github.com/acme/widgets.git', 'git@github.com:acme/widgets.git'],
      ['https://gitlab.com/acme/widgets.git'],
      [],
    ]) {
      expect(resolveRepositoryFromRemoteUrls(urls, allowlist)).toEqual({ status: 'refused', reason: 'unsupported-remote' });
    }
  });

  it('the refusal never carries a URL', () => {
    const result = resolveRepositoryFromRemoteUrls(['https://github.com/acme/other.git'], allowlist);
    expect(JSON.stringify(result)).not.toContain('github.com');
  });
});

describe('RepositoryAllowlist', () => {
  it('is case-insensitive, de-duplicates, keeps configuration order and returns copies', () => {
    const list = new RepositoryAllowlist([WIDGETS, { provider: 'github', owner: 'ACME', repo: 'WIDGETS' }, GADGETS]);
    expect(list.size).toBe(2);
    expect(list.entries).toEqual([WIDGETS, GADGETS]);
    expect(list.has({ owner: 'Acme', repo: 'Gadgets' })).toBe(true);
    expect(list.find({ owner: 'acme', repo: 'nope' })).toBeUndefined();
    const found = list.find(WIDGETS)!;
    found.repo = 'mutated';
    expect(list.find(WIDGETS)).toEqual(WIDGETS);
  });
});

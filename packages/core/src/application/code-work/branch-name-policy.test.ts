import { describe, expect, it } from 'vitest';
import { MAX_OWNER_BRANCH_NAME_LENGTH, isCreatableOwnerBranch, isProtectedBranch } from './branch-name-policy';

describe('isProtectedBranch', () => {
  it('protects main and master in any letter case', () => {
    for (const name of ['main', 'master', 'Main', 'MASTER', 'mAiN']) expect(isProtectedBranch(name), name).toBe(true);
  });

  it('does not protect other names, including look-alikes', () => {
    for (const name of ['feature/main', 'main2', 'mainline', 'develop', '', ' main']) expect(isProtectedBranch(name), name).toBe(false);
  });
});

describe('isCreatableOwnerBranch', () => {
  it('accepts conservative ASCII names with slashes, dots, dashes and underscores', () => {
    for (const name of ['feature/x', 'code-work/add-helper', 'fix_1.2', 'v1.0.0', 'a', 'Owner/Topic-9', 'a'.repeat(MAX_OWNER_BRANCH_NAME_LENGTH)]) {
      expect(isCreatableOwnerBranch(name), name).toBe(true);
    }
  });

  it('rejects main, master and HEAD in any letter case', () => {
    for (const name of ['main', 'Main', 'MASTER', 'master', 'HEAD', 'head', 'Head']) expect(isCreatableOwnerBranch(name), name).toBe(false);
  });

  it('rejects a refs/ prefix', () => {
    for (const name of ['refs/heads/x', 'refs/tags/v1', 'REFS/heads/x']) expect(isCreatableOwnerBranch(name), name).toBe(false);
  });

  it('rejects names longer than 100 characters', () => {
    expect(isCreatableOwnerBranch('a'.repeat(MAX_OWNER_BRANCH_NAME_LENGTH + 1))).toBe(false);
  });

  it('rejects non-ASCII, whitespace, control and shell/git-special characters', () => {
    for (const name of ['기능/x', 'café', 'a b', 'a\tb', 'a\nb', 'a:b', 'a~b', 'a^b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', 'a@b', 'a;b', 'a$b', 'a`b']) {
      expect(isCreatableOwnerBranch(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('rejects names that fail the conservative push-branch check', () => {
    for (const name of ['', '-x', '/x', 'x/', 'a//b', 'a..b', 'x.lock']) expect(isCreatableOwnerBranch(name), name).toBe(false);
  });

  it('rejects git-invalid dot forms the push check does not cover', () => {
    for (const name of ['.hidden', 'feature/.x', 'x.', 'feature/x.']) expect(isCreatableOwnerBranch(name), name).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isCreatableOwnerBranch(undefined as unknown as string)).toBe(false);
    expect(isCreatableOwnerBranch(null as unknown as string)).toBe(false);
  });
});

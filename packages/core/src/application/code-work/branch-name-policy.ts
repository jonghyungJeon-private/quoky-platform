import { isSafePushBranch } from '../push-target';

/**
 * Owner branch naming policy (ADR-0099 D4). Pure and provider-agnostic: no I/O, no git, no config.
 *
 * Shared by `GitManager.createBranch`/`switchBranch` (capability-level backstop), the local git adapter, the
 * personal git guard and the future branch-command handler, so a name that one layer accepts is accepted by all.
 */

/** Maximum accepted length of an owner-created branch name. */
export const MAX_OWNER_BRANCH_NAME_LENGTH = 100;

/** Branch names that are protected from commits, creation and push (ADR-0094; compared case-insensitively). */
const PROTECTED_BRANCH_NAMES: ReadonlySet<string> = new Set(['main', 'master']);

/** ASCII-only branch alphabet: letters, digits, `.`, `_`, `/`, `-`. */
const OWNER_BRANCH_ALPHABET = /^[A-Za-z0-9._/-]+$/;

/** True for `main`/`master` in any letter case (surrounding whitespace is not trimmed: callers pass the exact name). */
export function isProtectedBranch(name: string): boolean {
  return typeof name === 'string' && PROTECTED_BRANCH_NAMES.has(name.toLowerCase());
}

/**
 * True when `name` may be created (or switched to) by the owner through Quoky: ASCII `[A-Za-z0-9._/-]`, at most
 * {@link MAX_OWNER_BRANCH_NAME_LENGTH} characters, passes `isSafePushBranch`, is not `main`/`master`/`HEAD`
 * (case-insensitive), has no `refs/` prefix, and follows the git rules the conservative push check does not cover
 * (no path component starting with `.`, no trailing `.`).
 */
export function isCreatableOwnerBranch(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_OWNER_BRANCH_NAME_LENGTH) return false;
  if (!OWNER_BRANCH_ALPHABET.test(name)) return false;
  if (!isSafePushBranch(name)) return false;
  const lower = name.toLowerCase();
  if (isProtectedBranch(name) || lower === 'head') return false;
  if (lower.startsWith('refs/')) return false;
  if (name.endsWith('.')) return false;
  if (name.split('/').some((part) => part.startsWith('.'))) return false;
  return true;
}

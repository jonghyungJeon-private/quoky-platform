/**
 * Deterministic candidate project-relative file-path extraction from raw user text (Sprint 2o,
 * ADR-0036). Pure, synchronous, no I/O, no Workspace access — finds tokens that LOOK like a
 * project-relative file path (require a `/`, per CA Round 1 — rejects bare filenames, "Node.js",
 * "e.g.", "v1.2.3"), in order of appearance, filtering out anything absolute or containing a `..`
 * segment. A candidate here is NEVER trusted as sufficient scope on its own — the caller
 * (ConversationRuntime) must validate it exists in the real workspace via the existing read-only
 * Workspace capability (`WorkspaceManager.list`) before treating it as a target file.
 *
 * This module is a pure Application-layer parser helper — not a capability, not a domain service,
 * not a port/adapter/repository.
 */
export function extractTargetPathCandidates(text: string): string[] {
  const matches = text.match(/\b[\w][\w./-]*\.[a-zA-Z0-9]+\b/g) ?? [];
  const out: string[] = [];
  for (const m of matches) {
    if (!m.includes('/')) continue; // require a path separator — rejects bare filenames/tokens
    if (m.startsWith('/') || m.startsWith('.')) continue; // absolute or hidden/dot-relative
    if (m.split('/').includes('..')) continue; // traversal
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * Every token the user typed that LOOKS like a file path (QA-016), INCLUDING the ones
 * {@link extractTargetPathCandidates} refuses (absolute, `..` traversal, dot/home-relative) — so the runtime can
 * tell "no path was given" from "a path was given but cannot be used". Display-only: a token here is never a
 * target, is never resolved, and is never checked for existence (an out-of-root file's existence is not revealed).
 * Path-like = contains `/` and (starts with `/`, `./`, `../`, `~/`, or ends in a `.ext`, or has 3+ segments), so
 * "7/3", "A/B", "UI/UX" and URLs (`https://…`) are not paths. Fenced code blocks are ignored.
 */
export function extractMentionedPathTokens(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  const out: string[] = [];
  for (const match of prose.matchAll(/[\w@.~/-]+/g)) {
    const token = match[0].replace(/\.+$/, '');
    if (!token.includes('/') || token.startsWith('//')) continue;
    const segments = token.split('/').filter((seg) => seg.length > 0);
    if (segments.length === 0) continue;
    const prefixed = /^(?:\/|\.{1,2}\/|~\/)/.test(token);
    const hasExtension = /\.[A-Za-z][A-Za-z0-9]*$/.test(segments[segments.length - 1] ?? '');
    if (!prefixed && !hasExtension && segments.length < 3) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Normalize a project-relative path for exact-match comparison against a Workspace-returned hit.
 * Strips a leading `./`, collapses duplicate slashes, drops a trailing slash. Never resolves `..` —
 * a path containing `..` is not made safe by this function; {@link extractTargetPathCandidates}
 * already rejects those before they reach here.
 */
export function normalizeRelativePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

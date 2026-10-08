/**
 * Preview delivery model (Sprint 4c-Follow-up-5, F5-A/F5-B). Platform-neutral: this module carries a
 * COMPLETE code-change preview and a PURE, lossless splitter for its canonical diff. It embeds NO platform
 * constant and no platform API — the caller (a platform adapter) supplies the per-segment payload budget
 * and owns all presentation (message limits, `[n/m]`, code fences, sequencing, attachments) (CA RC1).
 *
 * Losslessness (CA RC3): `splitCanonicalDiff` returns canonical PAYLOAD segments only — no wrappers — such
 * that `segments.join('') === canonicalDiff` byte-for-byte. A diff line is never split; if one line alone
 * exceeds the payload budget the split is impossible and the caller must use the attachment fallback.
 */

import type { PreviewFile } from '../domain';

// Re-export the domain preview types so callers can import them alongside the split helpers.
export type { PreviewArtifact, PreviewFile } from '../domain';

/** Result of a lossless canonical-diff split against a caller-supplied per-segment payload budget. */
export type CanonicalSplit =
  | { kind: 'segments'; segments: string[] }
  | { kind: 'attachment-required'; reason: 'line-exceeds-budget' | 'empty-budget' };

/**
 * Build the canonical diff for a set of preview files under one newline policy: each file's unified diff,
 * normalized to end with exactly one trailing `\n`, concatenated in order. Deterministic and reversible.
 */
export function buildCanonicalDiff(files: readonly PreviewFile[]): string {
  return files.map((f) => (f.unifiedDiff.endsWith('\n') ? f.unifiedDiff : `${f.unifiedDiff}\n`)).join('');
}

/**
 * Split a canonical diff into ordered PAYLOAD segments whose concatenation reproduces the input
 * byte-for-byte (CA RC3), each within `payloadBudget` characters. Boundary preference (CA RC4): file
 * boundary → hunk (`@@`) boundary → complete line boundary. A diff line is NEVER split; if a single line
 * (including its trailing newline) exceeds the budget, the split is impossible → `attachment-required`.
 *
 * `payloadBudget` is the room for canonical content ONLY — the caller must subtract its own wrapper
 * overhead (fences, `[n/m]`, headers, newlines) BEFORE calling (CA RC1/RC5).
 */
export function splitCanonicalDiff(canonicalDiff: string, payloadBudget: number): CanonicalSplit {
  if (payloadBudget <= 0) return { kind: 'attachment-required', reason: 'empty-budget' };
  if (canonicalDiff.length === 0) return { kind: 'segments', segments: [] };
  if (canonicalDiff.length <= payloadBudget) return { kind: 'segments', segments: [canonicalDiff] };

  // Preserve every character including newlines: split into lines that KEEP their trailing '\n' so
  // `lines.join('') === canonicalDiff`. A final line without a trailing newline is kept as-is.
  const lines = canonicalDiff.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const line of lines) {
    if (line.length > payloadBudget) return { kind: 'attachment-required', reason: 'line-exceeds-budget' };
  }

  // The START of a new file block or a new hunk is a preferred segment boundary (CA RC4). `--- `/`+++ `
  // lines are part of the CURRENT file's header, NOT a new-file boundary — never treated as breaks.
  const startsFile = (l: string): boolean => /^(diff --git |Index: )/.test(l);
  const startsHunk = (l: string): boolean => /^@@ /.test(l);
  // Only realign to a boundary once the current segment is already substantial, so a small multi-file diff
  // that fits the budget is not needlessly fragmented.
  const boundaryMin = Math.floor(payloadBudget * 0.6);

  const segments: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = '';
  };

  for (const line of lines) {
    const wouldOverflow = current.length + line.length > payloadBudget;
    const boundaryRealign = (startsFile(line) || startsHunk(line)) && current.length >= boundaryMin;
    // Never split a diff LINE: flush the whole current segment; `line` starts the next one (so a boundary
    // line that triggers the flush naturally begins a fresh segment). Losslessness is preserved because we
    // only ever concatenate whole lines and every line joins back to `canonicalDiff`.
    if (current.length > 0 && (wouldOverflow || boundaryRealign)) flush();
    current += line;
  }
  flush();
  return { kind: 'segments', segments };
}

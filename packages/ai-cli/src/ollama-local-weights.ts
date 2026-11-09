/**
 * ADR-0124 Part L C5a (review round 2, Codex P1 + CA P2): the check that keeps a long-item summary on this host, for the
 * Ollama model used under `requiredLocality: 'LOCAL'`. The name rule (ADR-0107 D6: `cloud` in the name or tag is REMOTE)
 * cannot see through a local alias of a cloud-served model (`ollama cp`, or a Modelfile `FROM` a cloud model), so readiness
 * also reads the daemon's own metadata for the configured model. Read-only: `ollama list` / `ollama show` talk to the local
 * daemon, never pull, never load the model and send no input.
 *
 * Fail closed: the model is ready only on POSITIVE local evidence. Every probe error, timeout, unknown format or missing
 * field is "not ready".
 */

/** A pinned model digest: the 12-hex `ID` column `ollama list` prints (the same `digest12` stage R pins). */
const PINNED_DIGEST = /^[0-9a-f]{12}$/u;

/** Throws on a malformed pin, so a misconfigured pin fails at construction instead of silently disabling the check. */
export function validatedOllamaPinnedDigest(pin: string | undefined): string | undefined {
  if (pin === undefined) return undefined;
  if (!PINNED_DIGEST.test(pin)) throw new TypeError('Ollama pinned digest must be the 12-hex ID that `ollama list` prints.');
  return pin;
}

/**
 * True only when `ollama show <model>` is the CLI table this adapter recognizes AND it reports no remote field (review
 * round 3, Codex P2: an empty or unknown format is not evidence of a local model). Recognized means a section header line
 * that is exactly `Model` and, inside that section, an `architecture` row. Remote means a row whose field name starts with
 * `remote` (any case; the daemon's `remote_model`/`remote_host` print as `Remote …` rows) or a JSON-style key that starts
 * with `remote` in either snake or camel case. A false "remote" hit only makes a model unavailable (fail closed).
 */
export function ollamaShowIsLocalModel(showOutput: string): boolean {
  const lines = showOutput.split(/\r?\n/u);
  if (lines.some((line) => /^remote(?:[\s_:A-Z]|$)/iu.test(line.trim()) || /"remote[A-Za-z_]*"\s*:/u.test(line))) return false;
  const header = lines.findIndex((line) => line.trim() === 'Model');
  if (header < 0) return false;
  for (const line of lines.slice(header + 1)) {
    const row = line.trim();
    if (row === '') break;
    if (/^architecture\s+\S/u.test(row)) return true;
  }
  return false;
}

/** An absolute path whose last segment is a content-addressed weights blob (`sha256-<64 hex>`, as the daemon stores it). */
function isLocalBlobPath(path: string): boolean {
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path);
  return absolute && /[\\/]sha256-[0-9a-f]{64}$/u.test(path);
}

/**
 * True when `ollama show --modelfile <model>` parses under a strict grammar and names only local weights (review round 3,
 * Codex P2 + CA P3-c). Grammar: blank lines and `#` comment lines are skipped; every other line outside a `"""` block
 * starts at column 0 with an upper-case directive word followed by whitespace; a directive whose value opens `"""` without
 * closing it on the same line starts a block that runs to the next line containing `"""` (block lines are never read as
 * directives, so a `FROM` inside TEMPLATE/LICENSE/SYSTEM text cannot fake or spoil evidence). Every `FROM` directive must
 * be exactly one absolute `sha256-<64 hex>` blob path, and there must be at least one. Anything else (a lower-case or
 * indented directive, a bare or multi-token `FROM`, an unterminated block) is malformed and refused.
 */
export function ollamaModelfileFromLocalBlob(modelfile: string): boolean {
  let inBlock = false;
  let froms = 0;
  for (const line of modelfile.split(/\r?\n/u)) {
    if (inBlock) {
      if (line.includes('"""')) inBlock = false;
      continue;
    }
    if (line.trim() === '' || line.startsWith('#')) continue;
    const directive = /^([A-Z]+)[ \t]+(\S.*)$/u.exec(line);
    if (directive === null) return false;
    const [, word, rawValue] = directive as unknown as [string, string, string];
    const value = rawValue.trimEnd();
    if (word === 'FROM') {
      if (/\s/u.test(value) || !isLocalBlobPath(value)) return false;
      froms += 1;
      continue;
    }
    if (value.startsWith('"""') && !value.slice(3).includes('"""')) inBlock = true;
  }
  return !inBlock && froms > 0;
}

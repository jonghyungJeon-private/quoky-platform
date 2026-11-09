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
 * True when `ollama show <model>` reports a remote-backed model. The daemon's show response carries `remote_model` and
 * `remote_host` for such a model; the CLI table prints them as rows whose field name starts with `Remote`. A line whose
 * first word is that field name (any case, `_`/space/`:` separated), or a JSON key `"remote_…"` anywhere, counts: a false
 * hit only makes a model unavailable (fail closed), never available.
 */
export function ollamaShowDeclaresRemote(showOutput: string): boolean {
  return showOutput.split('\n').some((line) => /^remote(?:[\s_:]|$)/iu.test(line.trim()) || /"remote_[a-z]+"\s*:/iu.test(line));
}

/** An absolute path whose last segment is a content-addressed weights blob (`sha256-<64 hex>`). */
function isLocalBlobPath(path: string): boolean {
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path);
  return absolute && /[\\/]sha256[-:][0-9a-f]{64}$/u.test(path);
}

/**
 * True when `ollama show --modelfile <model>` names local weights: at least one `FROM` line, and every `FROM` line points
 * to a content-addressed blob on this host. A model the daemon serves from elsewhere has no local weights blob, so its
 * `FROM` names a model, not a blob path, and it is refused.
 */
export function ollamaModelfileFromLocalBlob(modelfile: string): boolean {
  const from = modelfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^FROM\s/iu.test(line))
    .map((line) => line.slice(4).trim());
  return from.length > 0 && from.every(isLocalBlobPath);
}

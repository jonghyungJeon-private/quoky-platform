import { tmpdir } from 'node:os';
import { defaultCliRunner } from './cli-runner';
import type { CliRunner } from './cli-runner';
import { OLLAMA_COLOR_ENV, OLLAMA_PROBE_TIMEOUT_MS, ollamaModelExecutionLocality } from './ollama-embedding-provider';

/**
 * The local Ollama model inventory for the owner's runtime model switch (ADR-0092 amendment, runtime switching).
 * `ollama list` talks to the local daemon only: it never pulls, never loads a model into memory and sends nothing off
 * this host. Only models whose name and tag carry no `cloud` (the ADR-0107 D6 `LOCAL` rule) are returned, so a
 * selectable Ollama chat model always runs on this host.
 */

/** A model name the inventory returns (the `NAME` column), bounded so it is a safe fixed argv element. */
const OLLAMA_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

/** At most this many models are returned (the owner's list stays readable; the rest are not selectable). */
export const MAX_LISTED_OLLAMA_MODELS = 20;

/** The `NAME` column of an `ollama list` table: local, well-formed names, in table order, de-duplicated. */
export function parseOllamaListModelNames(listOutput: string): string[] {
  const names: string[] = [];
  for (const line of listOutput.split('\n').slice(1)) {
    const name = line.trim().split(/\s+/u)[0] ?? '';
    if (!OLLAMA_MODEL_NAME.test(name) || ollamaModelExecutionLocality(name) !== 'LOCAL') continue;
    if (!names.includes(name)) names.push(name);
    if (names.length === MAX_LISTED_OLLAMA_MODELS) break;
  }
  return names;
}

export type OllamaModelInventory =
  | { readonly status: 'OK'; readonly models: readonly string[] }
  | { readonly status: 'UNAVAILABLE' };

/** One bounded `ollama list` call (5 s); a missing CLI, a stopped daemon or a timeout is `UNAVAILABLE`. */
export async function listLocalOllamaModels(
  bin = 'ollama',
  runner: CliRunner = defaultCliRunner,
): Promise<OllamaModelInventory> {
  try {
    const result = await runner(bin, ['list'], {
      cwd: tmpdir(),
      input: '',
      timeoutMs: OLLAMA_PROBE_TIMEOUT_MS,
      env: OLLAMA_COLOR_ENV,
    });
    if (result.code !== 0 || result.timedOut) return { status: 'UNAVAILABLE' };
    return { status: 'OK', models: parseOllamaListModelNames(result.stdout) };
  } catch {
    return { status: 'UNAVAILABLE' };
  }
}

/** The same exact-name rule as the provider's readiness probe: an untagged name means `:latest`. */
export function sameOllamaModel(a: string, b: string): boolean {
  const tagged = (name: string) => (name.includes(':') ? name : `${name}:latest`);
  return tagged(a) === tagged(b);
}

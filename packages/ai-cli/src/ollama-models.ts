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
  | {
      readonly status: 'OK';
      /** The chat-selectable local models. */
      readonly models: readonly string[];
      /** Installed local models that cannot chat (e.g. embedding-only), so a selection can say why it is refused. */
      readonly nonChat?: readonly string[];
    }
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

/** One `ollama list` row: the `NAME` and the `ID` (digest prefix) columns. */
export interface OllamaListEntry {
  readonly name: string;
  readonly id: string;
}

/** Like {@link parseOllamaListModelNames}, with each model's `ID` column (the capability cache key). */
export function parseOllamaListEntries(listOutput: string): OllamaListEntry[] {
  const entries: OllamaListEntry[] = [];
  for (const line of listOutput.split('\n').slice(1)) {
    const [name = '', id = ''] = line.trim().split(/\s+/u);
    if (!OLLAMA_MODEL_NAME.test(name) || ollamaModelExecutionLocality(name) !== 'LOCAL') continue;
    if (entries.some((entry) => entry.name === name)) continue;
    entries.push({ name, id });
    if (entries.length === MAX_LISTED_OLLAMA_MODELS) break;
  }
  return entries;
}

/**
 * The `Capabilities` section of `ollama show <model>` (Ollama 0.35 prints e.g. `completion`, `tools`, `thinking`,
 * `vision`, `embedding`, one per line, indented under the header; a nested detail line such as `levels true` is
 * indented deeper and ignored). `undefined` when the output has no such section (an older CLI or an unexpected format).
 */
export function parseOllamaShowCapabilities(showOutput: string): string[] | undefined {
  const lines = showOutput.split('\n');
  const header = lines.findIndex((line) => line.trim().toLowerCase() === 'capabilities');
  if (header < 0) return undefined;
  const headerIndent = (lines[header] ?? '').search(/\S/u);
  let itemIndent: number | undefined;
  const capabilities: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === '') {
      if (capabilities.length > 0) break;
      continue;
    }
    const indent = line.search(/\S/u);
    if (indent <= headerIndent) break;
    itemIndent ??= indent;
    if (indent !== itemIndent) continue;
    const capability = (line.trim().split(/\s+/u)[0] ?? '').toLowerCase();
    if (/^[a-z][a-z0-9_-]{0,31}$/u.test(capability) && !capabilities.includes(capability)) capabilities.push(capability);
  }
  return capabilities;
}

/**
 * The fallback when a model's capabilities cannot be read (`ollama show` failed, timed out or printed no
 * `Capabilities` section): a model whose name says it is an embedding model (`nomic-embed-text`, `mxbai-embed-large`,
 * `snowflake-arctic-embed`, `granite-embedding`, `embeddinggemma`) is treated as non-chat; any other model stays
 * selectable, as before capability checks existed. Deliberately narrow: it only ever hides a model, never adds one.
 */
export const OLLAMA_EMBEDDING_NAME_PATTERN = /embed/iu;

/** `ollama show` bound per model (local daemon metadata only; it never loads the model). */
export const OLLAMA_SHOW_TIMEOUT_MS = 3_000;
/** At most this many `ollama show` calls run at once on a cold cache. */
const OLLAMA_SHOW_CONCURRENCY = 4;

type ChatCapability = 'CHAT' | 'NON_CHAT';

export interface OllamaChatModelInventoryOptions {
  readonly bin?: string;
  /** Test seam; production uses the bounded default runner. */
  readonly runner?: CliRunner;
}

/**
 * The chat-selectable local Ollama models (runtime model switch): `ollama list`, then each model's capabilities from
 * `ollama show <model>` — a model without `completion` (an embedding-only model) is not a chat choice. A definite
 * capability answer is cached per model name and `ID`, so a later list costs one `ollama list` and a re-pulled model
 * (new `ID`) is checked again; an unreadable answer is not cached and falls back to
 * {@link OLLAMA_EMBEDDING_NAME_PATTERN}. Only local daemon metadata is read: nothing is pulled, loaded or sent anywhere.
 */
export class OllamaChatModelInventory {
  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly capabilityCache = new Map<string, ChatCapability>();

  constructor(options: OllamaChatModelInventoryOptions = {}) {
    this.bin = options.bin ?? 'ollama';
    this.runner = options.runner ?? defaultCliRunner;
  }

  async list(): Promise<OllamaModelInventory> {
    let entries: OllamaListEntry[];
    try {
      const result = await this.runner(this.bin, ['list'], {
        cwd: tmpdir(),
        input: '',
        timeoutMs: OLLAMA_PROBE_TIMEOUT_MS,
        env: OLLAMA_COLOR_ENV,
      });
      if (result.code !== 0 || result.timedOut) return { status: 'UNAVAILABLE' };
      entries = parseOllamaListEntries(result.stdout);
    } catch {
      return { status: 'UNAVAILABLE' };
    }
    const kinds: ChatCapability[] = new Array<ChatCapability>(entries.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length) {
        const index = next++;
        kinds[index] = await this.chatCapability(entries[index] as OllamaListEntry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(OLLAMA_SHOW_CONCURRENCY, entries.length) }, worker));
    // Entries no longer listed leave the cache, so it stays bounded by the inventory size.
    const live = new Set(entries.map(cacheKey));
    for (const key of this.capabilityCache.keys()) if (!live.has(key)) this.capabilityCache.delete(key);
    const models = entries.filter((_, i) => kinds[i] === 'CHAT').map((entry) => entry.name);
    const nonChat = entries.filter((_, i) => kinds[i] === 'NON_CHAT').map((entry) => entry.name);
    return { status: 'OK', models, ...(nonChat.length > 0 ? { nonChat } : {}) };
  }

  private async chatCapability(entry: OllamaListEntry): Promise<ChatCapability> {
    const key = cacheKey(entry);
    const cached = this.capabilityCache.get(key);
    if (cached !== undefined) return cached;
    const capabilities = await this.show(entry.name);
    if (capabilities === undefined) return OLLAMA_EMBEDDING_NAME_PATTERN.test(entry.name) ? 'NON_CHAT' : 'CHAT';
    const kind: ChatCapability = capabilities.includes('completion') ? 'CHAT' : 'NON_CHAT';
    this.capabilityCache.set(key, kind);
    return kind;
  }

  private async show(model: string): Promise<string[] | undefined> {
    try {
      // `model` passed the list's name rule (starts with an alphanumeric), so it is never read as a flag.
      const result = await this.runner(this.bin, ['show', model], {
        cwd: tmpdir(),
        input: '',
        timeoutMs: OLLAMA_SHOW_TIMEOUT_MS,
        env: OLLAMA_COLOR_ENV,
      });
      if (result.code !== 0 || result.timedOut) return undefined;
      return parseOllamaShowCapabilities(result.stdout);
    } catch {
      return undefined;
    }
  }
}

function cacheKey(entry: OllamaListEntry): string {
  return `${entry.name}\u0000${entry.id}`;
}

/** The same exact-name rule as the provider's readiness probe: an untagged name means `:latest`. */
export function sameOllamaModel(a: string, b: string): boolean {
  const tagged = (name: string) => (name.includes(':') ? name : `${name}:latest`);
  return tagged(a) === tagged(b);
}

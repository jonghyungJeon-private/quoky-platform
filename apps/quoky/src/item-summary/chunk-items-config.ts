import { parseChunkItemsMode, type ChunkItemsMode } from '@quoky/core';

/**
 * ADR-0124 Part L (DECISIONS ADR-0124 sections 7 and 17), parsed and validated only here (composition root) and folded
 * into `QuokyConfig.chunkItems` by `config.ts`. Typed value-free errors: the message is the code only, a configured value
 * is never echoed.
 *
 * - `QUOKY_CHUNK_ITEMS`: exactly `off`, `shadow` or `on`; unset is `off` (`CHUNK_ITEMS_INVALID` otherwise).
 * - `QUOKY_CHUNK_ITEMS_MODEL` (slice 2): the Ollama model the long-item provider runs, configured SEPARATELY from
 *   `QUOKY_OLLAMA_ENABLED` / `OLLAMA_MODEL` (chat stays where it is). A bounded `name[:tag]` token; a name or tag with
 *   `cloud` in it is refused (`CHUNK_ITEMS_MODEL_CLOUD_REFUSED`, ADR-0107 D6), anything else malformed is
 *   `CHUNK_ITEMS_MODEL_INVALID`.
 * - `QUOKY_CHUNK_ITEMS_MODEL_DIGEST` (slice 2): the 12-hex ID `ollama list` prints for that model, REQUIRED whenever a model
 *   is set (`CHUNK_ITEMS_MODEL_DIGEST_REQUIRED`), malformed is `CHUNK_ITEMS_MODEL_DIGEST_INVALID`, set without a model is
 *   `CHUNK_ITEMS_MODEL_DIGEST_WITHOUT_MODEL`. The provider is always registered with this pin.
 * - `on` needs the model and its digest (`CHUNK_ITEMS_ON_REQUIRES_MODEL`). `shadow` makes no model call and needs neither.
 */
export interface ChunkItemsConfig {
  readonly mode: ChunkItemsMode;
  /** The long-item model and its pinned digest; present only when both are configured. */
  readonly model?: { readonly name: string; readonly digest: string };
}

export const ChunkItemsConfigErrorCode = {
  CHUNK_ITEMS_INVALID: 'CHUNK_ITEMS_INVALID',
  CHUNK_ITEMS_MODEL_INVALID: 'CHUNK_ITEMS_MODEL_INVALID',
  CHUNK_ITEMS_MODEL_CLOUD_REFUSED: 'CHUNK_ITEMS_MODEL_CLOUD_REFUSED',
  CHUNK_ITEMS_MODEL_DIGEST_REQUIRED: 'CHUNK_ITEMS_MODEL_DIGEST_REQUIRED',
  CHUNK_ITEMS_MODEL_DIGEST_INVALID: 'CHUNK_ITEMS_MODEL_DIGEST_INVALID',
  CHUNK_ITEMS_MODEL_DIGEST_WITHOUT_MODEL: 'CHUNK_ITEMS_MODEL_DIGEST_WITHOUT_MODEL',
  CHUNK_ITEMS_ON_REQUIRES_MODEL: 'CHUNK_ITEMS_ON_REQUIRES_MODEL',
} as const;
export type ChunkItemsConfigErrorCode = (typeof ChunkItemsConfigErrorCode)[keyof typeof ChunkItemsConfigErrorCode];

export class ChunkItemsConfigError extends Error {
  constructor(readonly code: ChunkItemsConfigErrorCode) {
    super(code);
    this.name = 'ChunkItemsConfigError';
  }
}

/** One `name[:tag]` model token, the shape the embedding model uses (bounded, no path, no URL, no whitespace). */
const MODEL_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._/-]{0,79}';
const MODEL_SHAPE = new RegExp(`^${MODEL_SEGMENT}(?::${MODEL_SEGMENT})?$`, 'u');
/** The ID column of `ollama list`: exactly 12 lower-case hex digits (`validatedOllamaPinnedDigest`). */
const DIGEST_SHAPE = /^[0-9a-f]{12}$/u;

export function parseChunkItemsConfig(env: NodeJS.ProcessEnv): ChunkItemsConfig {
  const mode = parseChunkItemsMode(env.QUOKY_CHUNK_ITEMS);
  if (mode === undefined) throw new ChunkItemsConfigError(ChunkItemsConfigErrorCode.CHUNK_ITEMS_INVALID);
  const rawModel = env.QUOKY_CHUNK_ITEMS_MODEL;
  const rawDigest = env.QUOKY_CHUNK_ITEMS_MODEL_DIGEST;
  let model: ChunkItemsConfig['model'];
  if (rawModel !== undefined) {
    if (rawModel.toLowerCase().includes('cloud')) throw new ChunkItemsConfigError(ChunkItemsConfigErrorCode.CHUNK_ITEMS_MODEL_CLOUD_REFUSED);
    if (!MODEL_SHAPE.test(rawModel) || rawModel.includes('..')) throw new ChunkItemsConfigError(ChunkItemsConfigErrorCode.CHUNK_ITEMS_MODEL_INVALID);
    if (rawDigest === undefined) throw new ChunkItemsConfigError(ChunkItemsConfigErrorCode.CHUNK_ITEMS_MODEL_DIGEST_REQUIRED);
    if (!DIGEST_SHAPE.test(rawDigest)) throw new ChunkItemsConfigError(ChunkItemsConfigErrorCode.CHUNK_ITEMS_MODEL_DIGEST_INVALID);
    model = { name: rawModel, digest: rawDigest };
  } else if (rawDigest !== undefined) {
    throw new ChunkItemsConfigError(ChunkItemsConfigErrorCode.CHUNK_ITEMS_MODEL_DIGEST_WITHOUT_MODEL);
  }
  if (mode === 'on' && model === undefined) throw new ChunkItemsConfigError(ChunkItemsConfigErrorCode.CHUNK_ITEMS_ON_REQUIRES_MODEL);
  return model === undefined ? { mode } : { mode, model };
}

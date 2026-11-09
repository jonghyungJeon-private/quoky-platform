import { parseChunkItemsMode, type ChunkItemsMode } from '@quoky/core';

/**
 * ADR-0124 Part L slice C5a (DECISIONS ADR-0124 sections 7 and 17): `QUOKY_CHUNK_ITEMS`, parsed and validated only here
 * (composition root) and folded into `QuokyConfig.chunkItems` by `config.ts`. Typed value-free errors: the message is the
 * code only, a configured value is never echoed.
 *
 * - Exactly `off`, `shadow` or `on`; unset is `off`. Anything else is refused at startup (`CHUNK_ITEMS_INVALID`).
 * - C5a only validates the value: no handler reads it yet, so every value leaves every reply unchanged until the handler
 *   wiring slice. `on` will further need the section 7 gates and an independent Chief Architect review.
 */
export interface ChunkItemsConfig {
  readonly mode: ChunkItemsMode;
}

export const ChunkItemsConfigErrorCode = {
  CHUNK_ITEMS_INVALID: 'CHUNK_ITEMS_INVALID',
} as const;
export type ChunkItemsConfigErrorCode = (typeof ChunkItemsConfigErrorCode)[keyof typeof ChunkItemsConfigErrorCode];

export class ChunkItemsConfigError extends Error {
  constructor(readonly code: ChunkItemsConfigErrorCode) {
    super(code);
    this.name = 'ChunkItemsConfigError';
  }
}

export function parseChunkItemsConfig(env: NodeJS.ProcessEnv): ChunkItemsConfig {
  const mode = parseChunkItemsMode(env.QUOKY_CHUNK_ITEMS);
  if (mode === undefined) throw new ChunkItemsConfigError(ChunkItemsConfigErrorCode.CHUNK_ITEMS_INVALID);
  return { mode };
}

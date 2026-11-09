import { describe, expect, it } from 'vitest';
import { ChunkItemsConfigError, parseChunkItemsConfig } from './chunk-items-config';
import { QuokyConfigErrorCode } from '../config';
import { describeStartupFailure } from '../bootstrap-preflight';

// ADR-0124 Part L C5a: QUOKY_CHUNK_ITEMS — exact values, default off, anything else refused at startup, value never echoed.

describe('parseChunkItemsConfig', () => {
  it('defaults to off; accepts exactly off, shadow and on', () => {
    expect(parseChunkItemsConfig({})).toEqual({ mode: 'off' });
    for (const mode of ['off', 'shadow', 'on'] as const) expect(parseChunkItemsConfig({ QUOKY_CHUNK_ITEMS: mode })).toEqual({ mode });
  });

  it.each(['', 'On', 'ON', ' on', 'on ', 'true', 'active', 'local', 'shadow,on'])('refuses %j (CHUNK_ITEMS_INVALID), never echoing the value', (value) => {
    let error: unknown;
    try {
      parseChunkItemsConfig({ QUOKY_CHUNK_ITEMS: value });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChunkItemsConfigError);
    expect((error as ChunkItemsConfigError).code).toBe('CHUNK_ITEMS_INVALID');
    expect((error as Error).message).toBe('CHUNK_ITEMS_INVALID');
  });

  it('is a startup error code with a value-free preflight message', () => {
    expect(QuokyConfigErrorCode.CHUNK_ITEMS_INVALID).toBe('CHUNK_ITEMS_INVALID');
    expect(describeStartupFailure(new ChunkItemsConfigError('CHUNK_ITEMS_INVALID'))).toEqual({ message: 'CHUNK_ITEMS_INVALID', hint: 'QUOKY_CHUNK_ITEMS must be unset, "off", "shadow", or "on".' });
  });
});

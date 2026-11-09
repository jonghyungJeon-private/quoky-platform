import { describe, expect, it } from 'vitest';
import { ChunkItemsConfigError, parseChunkItemsConfig } from './chunk-items-config';
import { QuokyConfigErrorCode } from '../config';
import { describeStartupFailure } from '../bootstrap-preflight';

// ADR-0124 Part L: QUOKY_CHUNK_ITEMS (C5a) and the long-item model with its required pin (C5a-2). Exact values, default
// off, anything else refused at startup with a value-free code.

/** A 12-hex pin built at runtime (no ID-shaped literal in the source). */
const PIN = ['0a1b', '2c3d', '4e5f'].join('');
const MODEL = 'notes-model:8b';

function codeOf(env: NodeJS.ProcessEnv): string | undefined {
  try {
    parseChunkItemsConfig(env);
    return undefined;
  } catch (caught) {
    expect(caught).toBeInstanceOf(ChunkItemsConfigError);
    expect((caught as Error).message).toBe((caught as ChunkItemsConfigError).code);
    for (const value of Object.values(env)) if (value !== undefined && value.length > 2) expect((caught as Error).message).not.toContain(value);
    return (caught as ChunkItemsConfigError).code;
  }
}

describe('parseChunkItemsConfig', () => {
  it('defaults to off; off and shadow need no model; on needs the model and its pin', () => {
    expect(parseChunkItemsConfig({})).toEqual({ mode: 'off' });
    expect(parseChunkItemsConfig({ QUOKY_CHUNK_ITEMS: 'off' })).toEqual({ mode: 'off' });
    expect(parseChunkItemsConfig({ QUOKY_CHUNK_ITEMS: 'shadow' })).toEqual({ mode: 'shadow' });
    expect(codeOf({ QUOKY_CHUNK_ITEMS: 'on' })).toBe('CHUNK_ITEMS_ON_REQUIRES_MODEL');
    expect(parseChunkItemsConfig({ QUOKY_CHUNK_ITEMS: 'on', QUOKY_CHUNK_ITEMS_MODEL: MODEL, QUOKY_CHUNK_ITEMS_MODEL_DIGEST: PIN })).toEqual({
      mode: 'on',
      model: { name: MODEL, digest: PIN },
    });
    // A configured model with shadow / off is parsed (and unused until `on`).
    expect(parseChunkItemsConfig({ QUOKY_CHUNK_ITEMS: 'shadow', QUOKY_CHUNK_ITEMS_MODEL: MODEL, QUOKY_CHUNK_ITEMS_MODEL_DIGEST: PIN }).model).toEqual({ name: MODEL, digest: PIN });
  });

  it.each(['', 'On', 'ON', ' on', 'on ', 'true', 'active', 'local', 'shadow,on'])('refuses mode %j (CHUNK_ITEMS_INVALID), never echoing the value', (value) => {
    expect(codeOf({ QUOKY_CHUNK_ITEMS: value })).toBe('CHUNK_ITEMS_INVALID');
  });

  it('preflight matrix: the model and its pin', () => {
    const on = { QUOKY_CHUNK_ITEMS: 'on' };
    expect(codeOf({ ...on, QUOKY_CHUNK_ITEMS_MODEL: MODEL })).toBe('CHUNK_ITEMS_MODEL_DIGEST_REQUIRED');
    expect(codeOf({ QUOKY_CHUNK_ITEMS: 'shadow', QUOKY_CHUNK_ITEMS_MODEL: MODEL })).toBe('CHUNK_ITEMS_MODEL_DIGEST_REQUIRED');
    for (const digest of ['', PIN.toUpperCase(), PIN.slice(1), `${PIN}0`, `sha256:${PIN}`, ` ${PIN}`, PIN.replace(/.$/u, 'g')]) {
      expect(codeOf({ ...on, QUOKY_CHUNK_ITEMS_MODEL: MODEL, QUOKY_CHUNK_ITEMS_MODEL_DIGEST: digest }), JSON.stringify(digest)).toBe('CHUNK_ITEMS_MODEL_DIGEST_INVALID');
    }
    expect(codeOf({ QUOKY_CHUNK_ITEMS_MODEL_DIGEST: PIN })).toBe('CHUNK_ITEMS_MODEL_DIGEST_WITHOUT_MODEL');
    expect(codeOf({ ...on, QUOKY_CHUNK_ITEMS_MODEL_DIGEST: PIN })).toBe('CHUNK_ITEMS_MODEL_DIGEST_WITHOUT_MODEL');
    for (const model of ['big-model:cloud', 'notes:8b-Cloud', 'CLOUDY']) {
      expect(codeOf({ ...on, QUOKY_CHUNK_ITEMS_MODEL: model, QUOKY_CHUNK_ITEMS_MODEL_DIGEST: PIN }), model).toBe('CHUNK_ITEMS_MODEL_CLOUD_REFUSED');
    }
    for (const model of ['', ' notes', 'notes model', 'notes:8b:extra', '../notes', 'a..b', '-notes', 'https://x', 'n'.repeat(81)]) {
      expect(codeOf({ ...on, QUOKY_CHUNK_ITEMS_MODEL: model, QUOKY_CHUNK_ITEMS_MODEL_DIGEST: PIN }), JSON.stringify(model)).toBe('CHUNK_ITEMS_MODEL_INVALID');
    }
  });

  it('every code is a startup error with a value-free preflight hint', () => {
    const hints: Record<string, string> = {
      CHUNK_ITEMS_INVALID: 'QUOKY_CHUNK_ITEMS must be unset, "off", "shadow", or "on".',
    };
    for (const code of [
      'CHUNK_ITEMS_INVALID',
      'CHUNK_ITEMS_MODEL_INVALID',
      'CHUNK_ITEMS_MODEL_CLOUD_REFUSED',
      'CHUNK_ITEMS_MODEL_DIGEST_REQUIRED',
      'CHUNK_ITEMS_MODEL_DIGEST_INVALID',
      'CHUNK_ITEMS_MODEL_DIGEST_WITHOUT_MODEL',
      'CHUNK_ITEMS_ON_REQUIRES_MODEL',
    ] as const) {
      expect((QuokyConfigErrorCode as Record<string, string>)[code]).toBe(code);
      const described = describeStartupFailure(new ChunkItemsConfigError(code));
      expect(described.message).toBe(code);
      expect(described.hint).toMatch(/QUOKY_CHUNK_ITEMS/u);
      if (hints[code] !== undefined) expect(described.hint).toBe(hints[code]);
      expect(described.hint).not.toContain(PIN);
    }
  });
});

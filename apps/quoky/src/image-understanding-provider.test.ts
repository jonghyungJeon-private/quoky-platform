import { describe, expect, it } from 'vitest';
import { Capability, executionLocalityOf } from '@quoky/core';
import type { LogFields, Logger } from '@quoky/core';
import {
  ImageUnderstandingConfigErrorCode,
  createImageUnderstandingProviders,
  loadImageUnderstandingConfig,
} from './image-understanding-provider';

function recordingLogger() {
  const warns: Array<{ message: string; fields?: LogFields }> = [];
  const logger: Logger = {
    info: () => undefined,
    error: () => undefined,
    warn: (message, fields) => { warns.push({ message, ...(fields ? { fields } : {}) }); },
  };
  return { logger, warns };
}

describe('image understanding composition (ADR-0111 D4/D5, MM-2)', () => {
  it('unset or empty QUOKY_OLLAMA_VISION_MODEL registers nothing', () => {
    expect(loadImageUnderstandingConfig({})).toEqual({ enabled: false });
    expect(loadImageUnderstandingConfig({ QUOKY_OLLAMA_VISION_MODEL: '  ' })).toEqual({ enabled: false });
    const { logger, warns } = recordingLogger();
    expect(createImageUnderstandingProviders({}, { ollamaBin: 'ollama', logger })).toEqual([]);
    expect(warns).toHaveLength(0);
  });

  it('a local model registers one LOCAL provider advertising only IMAGE_UNDERSTANDING', () => {
    const { logger } = recordingLogger();
    const providers = createImageUnderstandingProviders(
      { QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
      { ollamaBin: '/opt/homebrew/bin/ollama', logger },
    );
    expect(providers).toHaveLength(1);
    expect(providers[0]?.capabilities.map((c) => c.capability)).toEqual([Capability.IMAGE_UNDERSTANDING]);
    expect(executionLocalityOf(providers[0]!)).toBe('LOCAL');
  });

  it('a cloud-served or malformed model disables image understanding with a value-free code', () => {
    expect(loadImageUnderstandingConfig({ QUOKY_OLLAMA_VISION_MODEL: 'qwen3-vl:235b-cloud' })).toEqual({
      enabled: false,
      invalid: ImageUnderstandingConfigErrorCode.VISION_MODEL_NOT_LOCAL,
    });
    for (const value of ['--help', 'gemma3 4b', 'a;rm']) {
      expect(loadImageUnderstandingConfig({ QUOKY_OLLAMA_VISION_MODEL: value }), value).toEqual({
        enabled: false,
        invalid: ImageUnderstandingConfigErrorCode.VISION_MODEL_INVALID,
      });
    }
    const { logger, warns } = recordingLogger();
    expect(
      createImageUnderstandingProviders({ QUOKY_OLLAMA_VISION_MODEL: 'llava:7b-cloud' }, { ollamaBin: 'ollama', logger }),
    ).toEqual([]);
    expect(warns).toEqual([
      { message: 'image understanding not registered', fields: { reason: 'OLLAMA_VISION_MODEL_NOT_LOCAL' } },
    ]);
    expect(JSON.stringify(warns)).not.toContain('llava');
  });
});

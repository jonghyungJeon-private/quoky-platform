import { describe, expect, it } from 'vitest';
import { ClaudeCliVisionProvider, OllamaCliVisionProvider } from '@quoky/ai-cli';
import { Capability, executionLocalityOf } from '@quoky/core';
import type { LogFields, Logger } from '@quoky/core';
import { ImageUnderstandingConfigErrorCode, parseImageUnderstandingConfig } from './config';
import type { ImageUnderstandingConfig } from './config';
import {
  createImageUnderstandingProviders,
  describeImageUnderstandingSelection,
  imageUnderstandingLocalitiesFor,
} from './image-understanding-provider';

function recordingLogger() {
  const warns: Array<{ message: string; fields?: LogFields }> = [];
  const infos: Array<{ message: string; fields?: LogFields }> = [];
  const logger: Logger = {
    info: (message, fields) => { infos.push({ message, ...(fields ? { fields } : {}) }); },
    error: () => undefined,
    warn: (message, fields) => { warns.push({ message, ...(fields ? { fields } : {}) }); },
  };
  return { logger, warns, infos };
}

const BINS = { ollamaBin: '/opt/homebrew/bin/ollama', claudeBin: '/usr/local/bin/claude' };
const compose = (config: ImageUnderstandingConfig) => {
  const { logger, warns, infos } = recordingLogger();
  return { providers: createImageUnderstandingProviders(config, { ...BINS, logger }), warns, infos };
};

describe('image understanding composition (ADR-0111 D4/D5 + amendment A1/A2)', () => {
  it('off (the default when nothing is configured) registers nothing and keeps the local-only policy', () => {
    const config = parseImageUnderstandingConfig({});
    expect(config).toEqual({ provider: 'off' });
    const { providers, warns } = compose(config);
    expect(providers).toEqual([]);
    expect(warns).toHaveLength(0);
    expect(imageUnderstandingLocalitiesFor(config)).toEqual(['LOCAL']);
    expect(describeImageUnderstandingSelection(config)).toEqual({ selection: 'off', locality: 'NONE' });
  });

  it('ollama registers exactly one LOCAL provider advertising only IMAGE_UNDERSTANDING; the policy stays LOCAL', () => {
    for (const env of [
      { QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
      { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'ollama', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
    ]) {
      const config = parseImageUnderstandingConfig(env);
      const { providers } = compose(config);
      expect(providers).toHaveLength(1);
      expect(providers[0]).toBeInstanceOf(OllamaCliVisionProvider);
      expect(providers[0]?.capabilities.map((c) => c.capability)).toEqual([Capability.IMAGE_UNDERSTANDING]);
      expect(executionLocalityOf(providers[0]!)).toBe('LOCAL');
      expect(imageUnderstandingLocalitiesFor(config)).toEqual(['LOCAL']);
    }
  });

  it('claude registers exactly one REMOTE Claude vision provider and opens the policy to REMOTE', () => {
    const config = parseImageUnderstandingConfig({ QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' });
    expect(config).toEqual({ provider: 'claude', model: 'sonnet' });
    const { providers, infos } = compose(config);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(ClaudeCliVisionProvider);
    expect(providers[0]?.capabilities.map((c) => c.capability)).toEqual([Capability.IMAGE_UNDERSTANDING]);
    expect(executionLocalityOf(providers[0]!)).toBe('REMOTE');
    expect((providers[0] as ClaudeCliVisionProvider).buildArgs().slice(0, 3)).toEqual(['-p', '--model', 'sonnet']);
    expect(imageUnderstandingLocalitiesFor(config)).toEqual(['LOCAL', 'REMOTE']);
    expect(describeImageUnderstandingSelection(config)).toEqual({ selection: 'claude', locality: 'REMOTE' });
    expect(infos).toEqual([
      { message: 'image understanding uses a cloud provider', fields: { selection: 'claude', locality: 'REMOTE' } },
    ]);
  });

  it('claude takes QUOKY_IMAGE_UNDERSTANDING_MODEL over QUOKY_CLAUDE_MODEL', () => {
    const provider = compose(
      parseImageUnderstandingConfig({
        QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude',
        QUOKY_CLAUDE_MODEL: 'opus',
        QUOKY_IMAGE_UNDERSTANDING_MODEL: 'haiku',
      }),
    ).providers[0] as ClaudeCliVisionProvider;
    expect(provider.buildArgs().slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
  });

  it('the legacy implicit path keeps its fail-closed, value-free handling of an unusable vision model', () => {
    expect(parseImageUnderstandingConfig({ QUOKY_OLLAMA_VISION_MODEL: 'qwen3-vl:235b-cloud' })).toEqual({
      provider: 'off',
      invalid: ImageUnderstandingConfigErrorCode.VISION_MODEL_NOT_LOCAL,
    });
    for (const value of ['--help', 'gemma3 4b', 'a;rm']) {
      expect(parseImageUnderstandingConfig({ QUOKY_OLLAMA_VISION_MODEL: value }), value).toEqual({
        provider: 'off',
        invalid: ImageUnderstandingConfigErrorCode.VISION_MODEL_INVALID,
      });
    }
    const { providers, warns } = compose(parseImageUnderstandingConfig({ QUOKY_OLLAMA_VISION_MODEL: 'llava:7b-cloud' }));
    expect(providers).toEqual([]);
    expect(warns).toEqual([
      { message: 'image understanding not registered', fields: { reason: 'OLLAMA_VISION_MODEL_NOT_LOCAL' } },
    ]);
    expect(JSON.stringify(warns)).not.toContain('llava');
  });
});

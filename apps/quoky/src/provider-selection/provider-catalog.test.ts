import {
  ClaudeCliProvider,
  ClaudeCliVisionProvider,
  CodexCliProvider,
  CodexCliVisionProvider,
  OllamaCliProvider,
  OllamaCliVisionProvider,
} from '@quoky/ai-cli';
import { describe, expect, it } from 'vitest';
import { AiProviderError, Capability } from '@quoky/core';
import { loadConfig } from '../config';
import { visionModelsOf } from '../image-understanding-provider';
import { MAX_ON_DEMAND_PROVIDERS, ProviderCatalog, chatTierView } from './provider-catalog';
import { CHAT_TIER_CAPABILITIES } from './selection-choices';
import { TEST_OWNER } from './test-support';

/**
 * ADR-0092 / ADR-0111 amendments (runtime switching): what is registered on a host, and the bounded, chat-tier-only
 * on-demand instances. Construction spawns nothing (presence is a filesystem lookup, injected here).
 */

const quiet = { info: () => undefined, warn: () => undefined };

function catalog(env: Record<string, string>, present: string[] = []) {
  const config = loadConfig({ QUOKY_DISCORD_OWNER_IDS: TEST_OWNER, ...env } as NodeJS.ProcessEnv);
  return new ProviderCatalog({ ai: config.ai, vision: visionModelsOf(config), cliPresent: (bin) => present.includes(bin), logger: quiet });
}

const ids = (c: ProviderCatalog) => c.providers.map((p) => p.id);

describe('ProviderCatalog registration', () => {
  it('Claude always; Codex when its CLI is present; Ollama chat when OLLAMA_MODEL is set and the CLI is present', () => {
    expect(ids(catalog({ QUOKY_CHAT_PROVIDER: 'claude' }))).toEqual(['claude-cli', 'claude-vision-cli']);
    expect(ids(catalog({ QUOKY_CHAT_PROVIDER: 'claude' }, ['codex']))).toEqual(['claude-cli', 'codex-cli', 'claude-vision-cli', 'codex-vision-cli']);
    // The CLI alone is not enough for the Ollama chat model: OLLAMA_MODEL must be configured.
    expect(ids(catalog({ QUOKY_CHAT_PROVIDER: 'claude' }, ['ollama']))).toEqual(['claude-cli', 'claude-vision-cli']);
    expect(ids(catalog({ QUOKY_CHAT_PROVIDER: 'claude', OLLAMA_MODEL: 'llama3.1' }, ['ollama', 'codex']))).toEqual([
      'claude-cli', 'ollama-cli', 'codex-cli', 'claude-vision-cli', 'codex-vision-cli',
    ]);
  });

  it('a configured selection registers its provider regardless of presence (an unready one falls back to Claude)', () => {
    expect(ids(catalog({ QUOKY_CHAT_PROVIDER: 'codex' }))).toEqual(['claude-cli', 'codex-cli', 'claude-vision-cli']);
    expect(ids(catalog({}))).toEqual(['claude-cli', 'ollama-cli', 'claude-vision-cli']);
  });

  it('a persisted operations-UI default registers its provider too', () => {
    const config = loadConfig({ QUOKY_DISCORD_OWNER_IDS: TEST_OWNER, QUOKY_CHAT_PROVIDER: 'claude' } as NodeJS.ProcessEnv);
    const c = new ProviderCatalog({ ai: config.ai, vision: {}, persistedChat: { provider: 'codex' }, cliPresent: () => false, logger: quiet });
    expect(ids(c)).toEqual(['claude-cli', 'codex-cli']);
  });

  it('uses the real adapters, with the configured binaries and models', () => {
    const c = catalog({ QUOKY_CHAT_PROVIDER: 'codex', QUOKY_CODEX_MODEL: 'gpt-5.1-codex', OLLAMA_MODEL: 'llama3.1', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' }, ['ollama']);
    expect(c.claude).toBeInstanceOf(ClaudeCliProvider);
    expect(c.codex).toBeInstanceOf(CodexCliProvider);
    expect(c.ollama).toBeInstanceOf(OllamaCliProvider);
    expect(c.ollamaVision).toBeInstanceOf(OllamaCliVisionProvider);
    expect(c.claudeVision).toBeInstanceOf(ClaudeCliVisionProvider);
    expect((c.codex as unknown as { buildArgs(): string[] }).buildArgs()).toEqual(expect.arrayContaining(['-m', 'gpt-5.1-codex']));
    expect(c.ollamaVision?.executionLocality).toBe('LOCAL');
    expect(c.claudeVision?.executionLocality).toBe('REMOTE');
  });

  it('the Codex image option: registered when the Codex CLI is present or codex is the configured or persisted image choice', () => {
    expect(catalog({ QUOKY_CHAT_PROVIDER: 'claude' }).resolveImage('codex')).toBeUndefined();
    const present = catalog({ QUOKY_CHAT_PROVIDER: 'claude' }, ['codex']);
    expect(present.codexVision).toBeInstanceOf(CodexCliVisionProvider);
    expect(present.resolveImage('codex')).toBe(present.codexVision);
    expect(present.codexVision?.executionLocality).toBe('REMOTE');
    expect(present.codexVision?.capabilities.map((d) => d.capability)).toEqual([Capability.IMAGE_UNDERSTANDING]);
    // Configured without the CLI: registered anyway (it shows as not ready instead of the choice silently vanishing).
    const configured = catalog({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'codex' });
    expect(ids(configured)).toEqual(['claude-cli', 'claude-vision-cli', 'codex-vision-cli']);
    const config = loadConfig({ QUOKY_DISCORD_OWNER_IDS: TEST_OWNER, QUOKY_CHAT_PROVIDER: 'claude' } as NodeJS.ProcessEnv);
    const persisted = new ProviderCatalog({ ai: config.ai, vision: {}, persistedImage: 'codex', cliPresent: () => false, logger: quiet });
    expect(ids(persisted)).toEqual(['claude-cli', 'codex-vision-cli']);
    // The chat Codex selection alone does not register the image option when the CLI is absent.
    expect(catalog({ QUOKY_CHAT_PROVIDER: 'codex' }).codexVision).toBeUndefined();
  });

  it('the Codex image provider uses the configured Codex binary and QUOKY_CODEX_MODEL (no separate image model)', () => {
    const c = catalog({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_CODEX_MODEL: 'gpt-5.1-codex', CODEX_CLI_BIN: '/opt/codex' }, ['/opt/codex']);
    const args = (c.codexVision as unknown as { buildArgs(paths: string[]): string[] }).buildArgs(['/t/image-1.png']);
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.1-codex', '--image', '/t/image-1.png']));
    expect((c.codexVision as unknown as { bin: string }).bin).toBe('/opt/codex');
  });

  it('an invalid QUOKY_IMAGE_UNDERSTANDING_MODEL (with another selection) leaves the Claude image option unavailable', () => {
    const c = catalog({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_MODEL: 'bad model' });
    expect(c.claudeVision).toBeUndefined();
    expect(c.resolveImage('claude')).toBeUndefined();
    expect(c.resolveImage('off')).toBeNull();
  });
});

describe('ProviderCatalog choices', () => {
  it('maps default choices to the registered instances and labels them', () => {
    const c = catalog({ QUOKY_CHAT_PROVIDER: 'codex', OLLAMA_MODEL: 'llama3.1' }, ['ollama']);
    expect(c.resolveChat({ provider: 'claude' })).toBe(c.claude);
    expect(c.resolveChat({ provider: 'claude', model: 'sonnet' })).toBe(c.claude);
    expect(c.resolveChat({ provider: 'codex' })).toBe(c.codex);
    expect(c.resolveChat({ provider: 'ollama' })).toBe(c.ollama);
    expect(c.resolveChat({ provider: 'ollama', model: 'llama3.1:latest' })).toBe(c.ollama);
    expect(c.label({ provider: 'claude' })).toBe('claude:sonnet');
    expect(c.label({ provider: 'ollama', model: 'llama3.1:latest' })).toBe('ollama:llama3.1');
    expect(c.label({ provider: 'codex' })).toBe('codex');
  });

  it('adds one chat-tier-only instance per non-default model, once, up to the bound', () => {
    const c = catalog({ QUOKY_CHAT_PROVIDER: 'claude' }, ['ollama']);
    const opus = c.resolveChat({ provider: 'claude', model: 'opus' });
    expect(opus?.id).toBe('claude-cli:opus');
    expect(c.resolveChat({ provider: 'claude', model: 'opus' })).toBe(opus);
    expect(opus?.capabilities.map((d) => d.capability).sort()).toEqual([...CHAT_TIER_CAPABILITIES].sort());
    const granite = c.resolveChat({ provider: 'ollama', model: 'granite3.3:8b' });
    expect(granite?.id).toBe('ollama-cli:granite3.3:8b');
    expect(granite?.executionLocality).toBe('LOCAL');
    // Not advertised: code generation (Ollama's own CODE_IMPLEMENTATION 40 is dropped by the view).
    expect(granite?.capabilities.some((d) => d.capability === Capability.CODE_IMPLEMENTATION)).toBe(false);
    expect(ids(c)).toEqual(['claude-cli', 'claude-vision-cli', 'claude-cli:opus', 'ollama-cli:granite3.3:8b']);
    for (let i = 0; c.providers.length < 2 + MAX_ON_DEMAND_PROVIDERS; i += 1) c.resolveChat({ provider: 'ollama', model: `m${i}` });
    expect(c.resolveChat({ provider: 'ollama', model: 'one-too-many' })).toBeUndefined();
    expect(c.providers).toHaveLength(2 + MAX_ON_DEMAND_PROVIDERS);
  });

  it('Codex and Ollama are unavailable choices when they cannot run here', () => {
    const c = catalog({ QUOKY_CHAT_PROVIDER: 'claude' });
    expect(c.canChoose('codex')).toBe(false);
    expect(c.canChoose('ollama')).toBe(false);
    expect(c.resolveChat({ provider: 'codex' })).toBeUndefined();
    expect(c.resolveChat({ provider: 'ollama', model: 'granite3.3:8b' })).toBeUndefined();
  });

  it('a chat-tier view refuses any other capability before reaching the adapter', async () => {
    let calls = 0;
    const view = chatTierView({
      id: 'inner',
      capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 50 }, { capability: Capability.CODE_IMPLEMENTATION, priority: 50 }],
      isAvailable: async () => true,
      execute: async () => {
        calls += 1;
        return { text: 'ok' };
      },
    }, 'inner:view');
    await expect(view.execute({ capability: Capability.CODE_IMPLEMENTATION, prompt: 'x' })).rejects.toBeInstanceOf(AiProviderError);
    expect(calls).toBe(0);
    expect((await view.execute({ capability: Capability.GENERAL_CHAT, prompt: 'x' })).text).toBe('ok');
    expect(view.executionLocality).toBeUndefined();
  });
});

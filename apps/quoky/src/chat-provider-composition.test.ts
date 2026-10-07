import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiProviderManager, Capability, CapabilityRouter, executionLocalityOf } from '@quoky/core';
import type { AiProvider } from '@quoky/core';
import { createChatAiProviders } from './chat-provider-composition';
import { loadConfig } from './config';

const OWNER = '111111111111111111';

function aiConfig(env: Record<string, string>) {
  return loadConfig({ QUOKY_DISCORD_OWNER_IDS: OWNER, ...env } as NodeJS.ProcessEnv).ai;
}

function recordingLogger() {
  const entries: Array<{ level: 'info' | 'warn'; message: string; meta?: Record<string, unknown> }> = [];
  return {
    entries,
    info: (message: string, meta?: Record<string, unknown>) => entries.push({ level: 'info', message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) => entries.push({ level: 'warn', message, meta }),
  };
}

const ids = (providers: readonly AiProvider[]) => providers.map((p) => p.id);

/** Every provider "ready" without spawning: the router then chooses purely by advertised capability priority. */
function readyRouter(providers: readonly AiProvider[]): CapabilityRouter {
  const ready = providers.map((provider) =>
    Object.assign(Object.create(Object.getPrototypeOf(provider) as object) as AiProvider, provider, {
      isAvailable: async () => true,
    }),
  );
  return new CapabilityRouter(new AiProviderManager(ready, { availabilityTtlMs: 0 }));
}

describe('createChatAiProviders — registration per selector (ADR-0092 amendment)', () => {
  it('claude: Claude only (the old QUOKY_OLLAMA_ENABLED=false)', () => {
    const logger = recordingLogger();
    expect(ids(createChatAiProviders(aiConfig({ QUOKY_CHAT_PROVIDER: 'claude' }), logger))).toEqual(['claude-cli']);
    expect(ids(createChatAiProviders(aiConfig({ QUOKY_OLLAMA_ENABLED: 'false' }), logger))).toEqual(['claude-cli']);
  });

  it('ollama: Ollama + Claude (the old default, and still the default when nothing is set)', () => {
    const logger = recordingLogger();
    expect(ids(createChatAiProviders(aiConfig({}), logger))).toEqual(['claude-cli', 'ollama-cli']);
    expect(ids(createChatAiProviders(aiConfig({ QUOKY_CHAT_PROVIDER: 'ollama' }), logger))).toEqual([
      'claude-cli',
      'ollama-cli',
    ]);
  });

  it('codex: Codex + Claude, and no Ollama chat provider', () => {
    const providers = createChatAiProviders(aiConfig({ QUOKY_CHAT_PROVIDER: 'codex' }), recordingLogger());
    expect(ids(providers)).toEqual(['claude-cli', 'codex-cli']);
    const codex = providers.find((p) => p.id === 'codex-cli');
    expect(executionLocalityOf(codex!)).toBe('REMOTE');
  });

  it('passes the configured Codex model and binary to the adapter', () => {
    const providers = createChatAiProviders(
      aiConfig({ QUOKY_CHAT_PROVIDER: 'codex', QUOKY_CODEX_MODEL: 'gpt-5.1-codex', CODEX_CLI_BIN: '/opt/codex' }),
      recordingLogger(),
    );
    const codex = providers.find((p) => p.id === 'codex-cli') as unknown as { buildArgs(): string[]; bin: string };
    expect(codex.buildArgs()).toEqual(expect.arrayContaining(['-m', 'gpt-5.1-codex']));
    expect(codex.bin).toBe('/opt/codex');
  });

  it('never registers an embedding or image provider (those are composed separately)', () => {
    for (const selector of ['claude', 'codex', 'ollama']) {
      const providers = createChatAiProviders(aiConfig({ QUOKY_CHAT_PROVIDER: selector }), recordingLogger());
      for (const provider of providers) {
        const advertised = provider.capabilities.map((c) => c.capability);
        expect(advertised).not.toContain(Capability.EMBEDDING);
        expect(advertised).not.toContain(Capability.IMAGE_UNDERSTANDING);
      }
    }
  });

  it('logs the selection, and a value-free warning when the selector overrides QUOKY_OLLAMA_ENABLED', () => {
    const quiet = recordingLogger();
    createChatAiProviders(aiConfig({ QUOKY_CHAT_PROVIDER: 'codex', QUOKY_OLLAMA_ENABLED: 'false' }), quiet);
    expect(quiet.entries.filter((e) => e.level === 'warn')).toEqual([]);
    expect(quiet.entries).toContainEqual({
      level: 'info',
      message: 'chat provider selected',
      meta: { chatProvider: 'codex', source: 'QUOKY_CHAT_PROVIDER' },
    });

    const conflicted = recordingLogger();
    const providers = createChatAiProviders(
      aiConfig({ QUOKY_CHAT_PROVIDER: 'codex', QUOKY_OLLAMA_ENABLED: 'true' }),
      conflicted,
    );
    expect(ids(providers)).toEqual(['claude-cli', 'codex-cli']);
    expect(conflicted.entries.filter((e) => e.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'QUOKY_CHAT_PROVIDER overrides a contradicting QUOKY_OLLAMA_ENABLED',
        meta: { code: 'CHAT_PROVIDER_OVERRIDES_OLLAMA_ENABLED', chatProvider: 'codex' },
      },
    ]);
  });
});

describe('createChatAiProviders — routing by priority (no provider-id branching)', () => {
  it('codex selected: Codex wins the chat tier; Claude keeps code, review, planning and policy-sensitive chat', async () => {
    const router = readyRouter(createChatAiProviders(aiConfig({ QUOKY_CHAT_PROVIDER: 'codex' }), recordingLogger()));
    for (const capability of [
      Capability.GENERAL_CHAT,
      Capability.SUMMARIZATION,
      Capability.DOCUMENT_ANALYSIS,
      Capability.READONLY_LOOKUP,
    ]) {
      expect((await router.select(capability)).id, capability).toBe('codex-cli');
    }
    for (const capability of [
      Capability.CODE_IMPLEMENTATION,
      Capability.CODE_REVIEW,
      Capability.POLICY_SENSITIVE_CHAT,
      Capability.PROJECT_ANALYSIS,
      Capability.ARCHITECTURE_PLANNING,
      Capability.TEST_EXECUTION,
    ]) {
      expect((await router.select(capability)).id, capability).toBe('claude-cli');
    }
  });

  it('ollama selected: unchanged from before (Ollama chat, Claude code)', async () => {
    const router = readyRouter(createChatAiProviders(aiConfig({}), recordingLogger()));
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('ollama-cli');
    expect((await router.select(Capability.CODE_IMPLEMENTATION)).id).toBe('claude-cli');
    expect((await router.select(Capability.POLICY_SENSITIVE_CHAT)).id).toBe('claude-cli');
  });

  it('claude selected: everything on Claude', async () => {
    const router = readyRouter(createChatAiProviders(aiConfig({ QUOKY_CHAT_PROVIDER: 'claude' }), recordingLogger()));
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('claude-cli');
    expect((await router.select(Capability.SUMMARIZATION)).id).toBe('claude-cli');
  });

  it('the composition chooses by configuration only; Core files never name the selector or a provider id', () => {
    const router = readFileSync(resolve(__dirname, '../../../packages/core/src/application/capability-router.ts'), 'utf8');
    expect(router).not.toMatch(/codex|QUOKY_CHAT_PROVIDER/i);
  });
});

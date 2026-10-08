import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Capability, NotImplementedError } from '@quoky/core';
import type { AiProvider, LogFields, Logger } from '@quoky/core';
import { AiProviderManager } from '@quoky/core';
import {
  BootstrapPreflightError,
  STARTUP_BANNER,
  assertDiscordTokenConfigured,
  describeStartupFailure,
  logResolvedDatabasePath,
  reportProviderReadiness,
} from './bootstrap-preflight';
import { parseProviderRoutingMode } from './provider-routing/provider-routing-activation';
import { loadConfig, QuokyConfigErrorCode } from './config';

interface LogLine { level: 'info' | 'warn' | 'error'; message: string; fields?: LogFields }

class RecordingLogger implements Logger {
  readonly lines: LogLine[] = [];
  info(message: string, fields?: LogFields): void { this.lines.push({ level: 'info', message, ...(fields ? { fields } : {}) }); }
  warn(message: string, fields?: LogFields): void { this.lines.push({ level: 'warn', message, ...(fields ? { fields } : {}) }); }
  error(message: string, fields?: LogFields): void { this.lines.push({ level: 'error', message, ...(fields ? { fields } : {}) }); }
  get text(): string { return JSON.stringify(this.lines); }
}

function provider(
  id: string,
  capabilities: readonly Capability[],
  availability: boolean | Error,
): AiProvider {
  return {
    id,
    capabilities: capabilities.map((capability) => ({ capability, priority: 50 })),
    async isAvailable() {
      if (availability instanceof Error) throw availability;
      return availability;
    },
    async execute() { throw new Error('not used'); },
  };
}

describe('assertDiscordTokenConfigured', () => {
  it.each([[{}], [{ DISCORD_BOT_TOKEN: '' }], [{ DISCORD_BOT_TOKEN: '   ' }]])(
    'fails fast with a remediation hint for a missing/blank token %j',
    (env) => {
      let caught: unknown;
      try { assertDiscordTokenConfigured(env); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(BootstrapPreflightError);
      const failure = describeStartupFailure(caught);
      expect(failure.message).toBe('DISCORD_BOT_TOKEN_MISSING');
      expect(failure.hint).toContain('DISCORD_BOT_TOKEN');
    },
  );

  it('accepts a non-blank token', () => {
    expect(() => assertDiscordTokenConfigured({ DISCORD_BOT_TOKEN: 'abc.def.ghi' })).not.toThrow();
  });
});

describe('describeStartupFailure', () => {
  it('maps the discord.js DisallowedIntents login error (by code or message) to a Developer Portal hint', () => {
    const byCode = Object.assign(new Error('Privileged intent provided is not enabled or whitelisted.'), {
      code: 'DisallowedIntents',
    });
    const byMessage = new Error('Used disallowed intents');
    for (const err of [byCode, byMessage]) {
      const failure = describeStartupFailure(err);
      expect(failure.message).toBe('DISCORD_DISALLOWED_INTENTS');
      expect(failure.hint).toMatch(/Message Content Intent/);
    }
  });

  it('maps an invalid Discord token login error to a token hint', () => {
    const failure = describeStartupFailure(Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }));
    expect(failure.message).toBe('DISCORD_TOKEN_INVALID');
    expect(failure.hint).toContain('DISCORD_BOT_TOKEN');
  });

  it('maps PROVIDER_ROUTING_INVALID_MODE (thrown by the real parser) to an env-name hint', () => {
    let caught: unknown;
    try { parseProviderRoutingMode('bogus-mode-value'); } catch (err) { caught = err; }
    const failure = describeStartupFailure(caught);
    expect(failure.message).toBe('PROVIDER_ROUTING_INVALID_MODE');
    expect(failure.hint).toContain('QUOKY_PROVIDER_ROUTING_MODE');
    expect(failure.hint).toContain('stage2b-general-chat-v1');
    expect(JSON.stringify(failure)).not.toContain('bogus-mode-value');
  });

  it('maps a missing QUOKY_DISCORD_OWNER_IDS (thrown by the real loader) to a hint naming only the variable', () => {
    let caught: unknown;
    try { loadConfig({}); } catch (err) { caught = err; }
    const failure = describeStartupFailure(caught);
    expect(failure.message).toBe('DISCORD_OWNER_IDS_MISSING');
    expect(failure.hint).toContain('QUOKY_DISCORD_OWNER_IDS');
  });

  it.each([
    [{ QUOKY_DISCORD_OWNER_IDS: 'not-a-snowflake-SECRETVALUE' }, 'DISCORD_OWNER_IDS_INVALID', 'QUOKY_DISCORD_OWNER_IDS'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_DISCORD_CHANNEL_IDS: 'oops-SECRETVALUE' }, 'DISCORD_CHANNEL_IDS_INVALID', 'QUOKY_DISCORD_CHANNEL_IDS'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_OLLAMA_ENABLED: 'yes-SECRETVALUE' }, 'OLLAMA_ENABLED_INVALID', 'QUOKY_OLLAMA_ENABLED'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_CLAUDE_MODEL: '--bad-SECRETVALUE' }, 'CLAUDE_MODEL_INVALID', 'QUOKY_CLAUDE_MODEL'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_CHAT_PROVIDER: 'gpt-SECRETVALUE' }, 'CHAT_PROVIDER_INVALID', 'QUOKY_CHAT_PROVIDER'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_CODEX_MODEL: '--bad-SECRETVALUE' }, 'CODEX_MODEL_INVALID', 'QUOKY_CODEX_MODEL'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_GIT_REMOTE_ENABLED: '1-SECRETVALUE' }, 'GIT_REMOTE_ENABLED_INVALID', 'QUOKY_GIT_REMOTE_ENABLED'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_CONTEXT_MAX_TOKENS: '-5-SECRETVALUE' }, 'CONTEXT_MAX_TOKENS_INVALID', 'QUOKY_CONTEXT_MAX_TOKENS'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_GIT_MERGE_ENABLED: 'true' }, 'GIT_MERGE_REQUIRES_REMOTE', 'QUOKY_GIT_MERGE_ENABLED'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_EMBEDDING_MODEL: 'x-cloud-SECRETVALUE' }, 'EMBEDDING_MODEL_CLOUD_REFUSED', 'QUOKY_EMBEDDING_MODEL'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_TIMEZONE: 'Mars/SECRETVALUE' }, 'TIMEZONE_INVALID', 'QUOKY_TIMEZONE'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_REMINDERS_ENABLED: '1-SECRETVALUE' }, 'REMINDERS_ENABLED_INVALID', 'QUOKY_REMINDERS_ENABLED'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_MEMORY_ARCHIVE_DAYS: '366-SECRETVALUE' }, 'MEMORY_ARCHIVE_DAYS_INVALID', 'QUOKY_MEMORY_ARCHIVE_DAYS'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'gpt-SECRETVALUE' }, 'IMAGE_UNDERSTANDING_PROVIDER_INVALID', 'QUOKY_IMAGE_UNDERSTANDING_PROVIDER'],
    [{ QUOKY_DISCORD_OWNER_IDS: '111111111111111111', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'ollama' }, 'IMAGE_UNDERSTANDING_OLLAMA_MODEL_MISSING', 'QUOKY_OLLAMA_VISION_MODEL'],
  ])('maps the real loader error for %j to a variable-naming hint without echoing the value', (env, code, variable) => {
    let caught: unknown;
    try { loadConfig(env as NodeJS.ProcessEnv); } catch (err) { caught = err; }
    const failure = describeStartupFailure(caught);
    expect(failure.message).toBe(code);
    expect(failure.hint).toContain(variable);
    expect(JSON.stringify(failure)).not.toContain('SECRETVALUE');
  });

  it('has a hint for every Personal-edition config error code', () => {
    for (const code of Object.values(QuokyConfigErrorCode)) {
      expect(describeStartupFailure(new Error(code)).hint, code).toMatch(/QUOKY_/);
    }
  });

  it('passes unknown errors through with secrets redacted and no hint', () => {
    const failure = describeStartupFailure(new Error('boom ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    expect(failure.hint).toBeUndefined();
    expect(failure.message).toContain('boom');
    expect(failure.message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(describeStartupFailure('plain string').message).toBe('plain string');
  });
});

describe('reportProviderReadiness', () => {
  it('logs ready providers with capability names, lists not-ready ones, and does not warn when chat is served', async () => {
    const claude = provider('claude-cli', [Capability.GENERAL_CHAT, Capability.CODE_IMPLEMENTATION], true);
    const ollama = provider('ollama-cli', [Capability.GENERAL_CHAT], false);
    const codex = provider('codex-cli', [Capability.CODE_IMPLEMENTATION], new NotImplementedError('x'));
    const log = new RecordingLogger();

    const report = await reportProviderReadiness(new AiProviderManager([claude, ollama, codex]), log);

    expect(report).toEqual({ ready: ['claude-cli'], notReady: ['ollama-cli', 'codex-cli'], notProbed: [], generalChatReady: true });
    expect(log.lines).toContainEqual({
      level: 'info',
      message: 'provider ready',
      fields: { provider: 'claude-cli', capabilities: 'GENERAL_CHAT,CODE_IMPLEMENTATION' },
    });
    expect(log.lines.filter((l) => l.message === 'provider not ready').map((l) => l.fields?.provider))
      .toEqual(['ollama-cli', 'codex-cli']);
    expect(log.lines.some((l) => l.level === 'warn')).toBe(false);
  });

  it('warns when no ready provider serves GENERAL_CHAT, even if a code-only provider is ready', async () => {
    const log = new RecordingLogger();
    const report = await reportProviderReadiness(
      new AiProviderManager([
        provider('claude-cli', [Capability.GENERAL_CHAT], false),
        provider('code-only', [Capability.CODE_IMPLEMENTATION], true),
      ]),
      log,
    );
    expect(report.generalChatReady).toBe(false);
    const warnings = log.lines.filter((l) => l.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('GENERAL_CHAT');
  });

  it('warns when there are no providers at all', async () => {
    const log = new RecordingLogger();
    const report = await reportProviderReadiness(new AiProviderManager([]), log);
    expect(report).toEqual({ ready: [], notReady: [], notProbed: [], generalChatReady: false });
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
  });
});

describe('logResolvedDatabasePath', () => {
  it('logs the absolute path resolved against the working directory', () => {
    const log = new RecordingLogger();
    const resolved = logResolvedDatabasePath('./data/chunsik.db', log, '/srv/quoky');
    expect(resolved).toBe(path.resolve('/srv/quoky', 'data/chunsik.db'));
    expect(log.lines).toEqual([{ level: 'info', message: 'database', fields: { path: resolved } }]);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('keeps an absolute path and the in-memory marker unchanged', () => {
    const log = new RecordingLogger();
    expect(logResolvedDatabasePath('/var/lib/quoky.db', log, '/elsewhere')).toBe('/var/lib/quoky.db');
    expect(logResolvedDatabasePath(':memory:', log, '/elsewhere')).toBe(':memory:');
  });
});

describe('startup logging hygiene', () => {
  it('contains names only: no token or other configured value reaches any preflight log', async () => {
    const secretToken = 'SECRET-DISCORD-TOKEN-VALUE-1234567890';
    const secretMode = 'SECRET-MODE-VALUE';
    const log = new RecordingLogger();

    let tokenError: unknown;
    try { assertDiscordTokenConfigured({ DISCORD_BOT_TOKEN: ' ' }); } catch (err) { tokenError = err; }
    let modeError: unknown;
    try { parseProviderRoutingMode(secretMode); } catch (err) { modeError = err; }
    for (const err of [tokenError, modeError, Object.assign(new Error(`login failed for ${secretToken}`), { code: 'DisallowedIntents' })]) {
      const failure = describeStartupFailure(err);
      log.error('failed to start', { error: failure.message });
      if (failure.hint) log.error('how to fix', { hint: failure.hint });
    }
    await reportProviderReadiness(new AiProviderManager([provider('claude-cli', [Capability.GENERAL_CHAT], true)]), log);
    log.info(STARTUP_BANNER);

    expect(log.text).not.toContain(secretToken);
    expect(log.text).not.toContain(secretMode);
    expect(STARTUP_BANNER).not.toMatch(/Sprint/);
  });
});

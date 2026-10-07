import path from 'node:path';
import { Capability } from '@quoky/core';
import type { AiProvider, Logger } from '@quoky/core';
import { QuokyConfigErrorCode } from './config';
import { redactSecrets } from './error-diagnostics';
import {
  PROVIDER_ROUTING_MODE_ENV_NAME,
  ProviderRoutingActivationErrorCode,
} from './provider-routing/provider-routing-activation';

/**
 * Testable startup preflight extracted from `main.ts`. Everything here logs NAMES only
 * (env var names, provider ids, capability names, an operator-owned file path) and never
 * a configured value, so a misconfigured start is diagnosable without leaking secrets.
 */

export const STARTUP_BANNER = 'started (Quoky Personal v1)';

const DISCORD_TOKEN_ENV_NAME = 'DISCORD_BOT_TOKEN';

/** A fail-fast startup problem with an operator-facing remediation hint. */
export class BootstrapPreflightError extends Error {
  constructor(
    readonly code: string,
    readonly hint: string,
  ) {
    super(code);
    this.name = 'BootstrapPreflightError';
  }
}

/** Fails before the composition root is evaluated when the Discord token is missing or blank. */
export function assertDiscordTokenConfigured(env: NodeJS.ProcessEnv): void {
  if ((env[DISCORD_TOKEN_ENV_NAME] ?? '').trim().length === 0) {
    throw new BootstrapPreflightError(
      'DISCORD_BOT_TOKEN_MISSING',
      `Set ${DISCORD_TOKEN_ENV_NAME} in the process environment or .env.local (Discord Developer Portal -> Bot -> Reset Token), then restart.`,
    );
  }
}

/**
 * Remediation hints for the Personal-edition configuration errors (ADR-0091/0092/0094/0073). Each hint names the
 * variable and the expected shape only — never a configured value.
 */
const CONFIG_ERROR_HINTS: Readonly<Record<QuokyConfigErrorCode, string>> = {
  [QuokyConfigErrorCode.DISCORD_OWNER_IDS_MISSING]:
    'Set QUOKY_DISCORD_OWNER_IDS to your Discord user id (comma-separated for several; Discord -> Settings -> Advanced -> Developer Mode, then right-click your name -> Copy User ID), then restart.',
  [QuokyConfigErrorCode.DISCORD_OWNER_IDS_INVALID]:
    'QUOKY_DISCORD_OWNER_IDS must be comma-separated Discord user ids (17-20 digits each, no empty entries).',
  [QuokyConfigErrorCode.DISCORD_CHANNEL_IDS_INVALID]:
    'QUOKY_DISCORD_CHANNEL_IDS must be unset/empty (direct messages only) or comma-separated Discord channel ids (17-20 digits each, no empty entries).',
  [QuokyConfigErrorCode.OLLAMA_ENABLED_INVALID]: 'QUOKY_OLLAMA_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.CLAUDE_MODEL_INVALID]:
    'QUOKY_CLAUDE_MODEL must be unset or a Claude model alias/name such as "sonnet" (letters, digits, and . _ : / [ ] -; up to 128 characters).',
  [QuokyConfigErrorCode.GIT_REMOTE_ENABLED_INVALID]: 'QUOKY_GIT_REMOTE_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.GIT_MERGE_ENABLED_INVALID]: 'QUOKY_GIT_MERGE_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.GIT_MERGE_REQUIRES_REMOTE]:
    'QUOKY_GIT_MERGE_ENABLED=true requires QUOKY_GIT_REMOTE_ENABLED=true; enable the remote first or leave QUOKY_GIT_MERGE_ENABLED unset.',
  [QuokyConfigErrorCode.WORK_SUMMARY_ENABLED_INVALID]: 'QUOKY_WORK_SUMMARY_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.EMBEDDING_ENABLED_INVALID]: 'QUOKY_EMBEDDING_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.EMBEDDING_MODEL_INVALID]:
    'QUOKY_EMBEDDING_MODEL must be unset or a local Ollama model name such as "nomic-embed-text" (lowercase letters, digits, . _ -, optional :tag; up to 64 characters each).',
  [QuokyConfigErrorCode.EMBEDDING_MODEL_CLOUD_REFUSED]:
    'QUOKY_EMBEDDING_MODEL must name a local model; a name or tag containing "cloud" is refused.',
  [QuokyConfigErrorCode.EMBEDDING_TIMEOUT_INVALID]:
    'QUOKY_EMBEDDING_TIMEOUT_MS must be unset or an integer from 100 to 30000.',
  [QuokyConfigErrorCode.LEARNING_EXAMPLES_ENABLED_INVALID]:
    'QUOKY_LEARNING_EXAMPLES_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.CONNECTOR_WRITES_ENABLED_INVALID]:
    'QUOKY_CONNECTOR_WRITES_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.CALENDAR_WRITE_ENABLED_INVALID]: 'QUOKY_CALENDAR_WRITE_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.CONNECTOR_WRITE_JIRA_PROJECTS_INVALID]:
    'QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS must be unset or a comma-separated list of distinct Jira project keys such as "PROJ,TEST" (at most 50).',
  [QuokyConfigErrorCode.CONNECTOR_WRITE_SLACK_CHANNELS_INVALID]:
    'QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS must be unset or a comma-separated list of distinct "name:CHANNELID" or "CHANNELID" entries such as "dev-test:C0123ABCD9" (at most 50).',
  [QuokyConfigErrorCode.CONNECTOR_WRITE_SLACK_TOKEN_INVALID]:
    'QUOKY_CONNECTOR_WRITE_SLACK_TOKEN must be a Slack bot token (chat:write) of the Quoky app; a user token is refused.',
  [QuokyConfigErrorCode.CONNECTOR_WRITE_SLACK_TOKEN_NOT_SEPARATE]:
    'QUOKY_CONNECTOR_WRITE_SLACK_TOKEN must differ from QUOKY_SLACK_TOKEN: Slack writes use a separate bot token.',
  [QuokyConfigErrorCode.MEMORY_ARCHIVE_DAYS_INVALID]:
    'QUOKY_MEMORY_ARCHIVE_DAYS must be unset or a whole number of days from 0 to 365 (0 = forgotten memories are deleted at once, no archive).',
  [QuokyConfigErrorCode.REMINDERS_ENABLED_INVALID]: 'QUOKY_REMINDERS_ENABLED must be unset, "true", or "false".',
  [QuokyConfigErrorCode.REMINDERS_CHANNEL_DELIVERY_INVALID]:
    'QUOKY_REMINDERS_CHANNEL_DELIVERY must be unset, "true", or "false".',
  [QuokyConfigErrorCode.TIMEZONE_INVALID]:
    'QUOKY_TIMEZONE must be unset or an IANA time zone such as "Asia/Seoul".',
  [QuokyConfigErrorCode.CONTEXT_MAX_TOKENS_INVALID]:
    'QUOKY_CONTEXT_MAX_TOKENS must be unset or a positive integer (at most 200000).',
  [QuokyConfigErrorCode.DISCORD_EXPECTED_BOT_ID_INVALID]:
    'QUOKY_DISCORD_EXPECTED_BOT_ID must be unset or the bot\'s Discord user id (17-20 digits; Developer Portal -> General Information -> Application ID).',
  [QuokyConfigErrorCode.DISCORD_EXPECTED_BOT_ID_REQUIRED]:
    'The launchd service requires QUOKY_DISCORD_EXPECTED_BOT_ID in the host .env.local (the bot\'s user id, 17-20 digits). Set it, then restart the service.',
  [QuokyConfigErrorCode.IMAGE_UNDERSTANDING_PROVIDER_INVALID]:
    'QUOKY_IMAGE_UNDERSTANDING_PROVIDER must be unset, "ollama", "claude", or "off" (lowercase). "claude" sends attached images to Anthropic (cloud).',
  [QuokyConfigErrorCode.IMAGE_UNDERSTANDING_MODEL_INVALID]:
    'QUOKY_IMAGE_UNDERSTANDING_MODEL must be unset or a Claude model alias/name such as "sonnet" (letters, digits, and . _ : / [ ] -; up to 128 characters).',
  [QuokyConfigErrorCode.IMAGE_UNDERSTANDING_OLLAMA_MODEL_MISSING]:
    'QUOKY_IMAGE_UNDERSTANDING_PROVIDER=ollama requires QUOKY_OLLAMA_VISION_MODEL (a local Ollama vision model such as "gemma3:4b").',
  [QuokyConfigErrorCode.IMAGE_UNDERSTANDING_OLLAMA_MODEL_INVALID]:
    'QUOKY_OLLAMA_VISION_MODEL must be a plain Ollama model name such as "gemma3:4b" (letters, digits, and . _ : / -; up to 128 characters).',
  [QuokyConfigErrorCode.IMAGE_UNDERSTANDING_OLLAMA_MODEL_NOT_LOCAL]:
    'QUOKY_OLLAMA_VISION_MODEL must name a local model; a name or tag containing "cloud" is refused (use QUOKY_IMAGE_UNDERSTANDING_PROVIDER=claude for a cloud image reader).',
  [QuokyConfigErrorCode.LAUNCHER_INVALID]:
    'QUOKY_LAUNCHER and QUOKY_LAUNCHER_RECENT_STARTS are written by ops/launchd/quoky-launch.sh only; remove them from .env.local and the shell.',
};

function configErrorCode(err: unknown, message: string): QuokyConfigErrorCode | undefined {
  const code = errorCode(err);
  return Object.values(QuokyConfigErrorCode).find((known) => known === code || known === message);
}

export interface StartupFailureReport {
  message: string;
  hint?: string;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Maps a startup error to a log-safe message plus, for known causes, a remediation hint. */
export function describeStartupFailure(err: unknown): StartupFailureReport {
  if (err instanceof BootstrapPreflightError) {
    return { message: err.code, hint: err.hint };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = errorCode(err);

  const configCode = configErrorCode(err, message);
  if (configCode !== undefined) return { message: configCode, hint: CONFIG_ERROR_HINTS[configCode] };

  // discord.js surfaces rejected privileged intents as `DisallowedIntents` on login.
  if (code === 'DisallowedIntents' || /disallowed intents|privileged intent/i.test(message)) {
    return {
      message: 'DISCORD_DISALLOWED_INTENTS',
      hint:
        'Enable the "Message Content Intent" under Discord Developer Portal -> Bot -> Privileged Gateway Intents, then restart.',
    };
  }
  if (code === 'TokenInvalid' || /invalid token/i.test(message)) {
    return {
      message: 'DISCORD_TOKEN_INVALID',
      hint: `${DISCORD_TOKEN_ENV_NAME} was rejected by Discord. Reset the bot token in the Developer Portal and update it.`,
    };
  }
  if (
    code === ProviderRoutingActivationErrorCode.INVALID_MODE ||
    message.includes(ProviderRoutingActivationErrorCode.INVALID_MODE)
  ) {
    return {
      message: ProviderRoutingActivationErrorCode.INVALID_MODE,
      hint: `${PROVIDER_ROUTING_MODE_ENV_NAME} must be unset, "legacy", or "stage2b-general-chat-v1".`,
    };
  }
  return { message: redactSecrets(message) };
}

/** Logs the absolute database path the process will really open (relative paths resolve from cwd). */
export function logResolvedDatabasePath(dbPath: string, log: Logger, cwd: string = process.cwd()): string {
  const resolved = dbPath === ':memory:' ? dbPath : path.resolve(cwd, dbPath);
  log.info('database', { path: resolved });
  return resolved;
}

export interface ProviderAvailabilitySource {
  all(): readonly AiProvider[];
  available(): Promise<AiProvider[]>;
}

export interface ProviderReadinessReport {
  ready: readonly string[];
  notReady: readonly string[];
  generalChatReady: boolean;
}

/** Logs which providers are ready (with their capabilities) and warns when chat cannot be served. */
export async function reportProviderReadiness(
  manager: ProviderAvailabilitySource,
  log: Logger,
): Promise<ProviderReadinessReport> {
  const ready = await manager.available();
  for (const provider of ready) {
    log.info('provider ready', {
      provider: provider.id,
      capabilities: provider.capabilities.map((c) => c.capability).join(','),
    });
  }
  const notReady = manager.all().filter((provider) => !ready.includes(provider));
  for (const provider of notReady) {
    log.info('provider not ready', { provider: provider.id });
  }

  const generalChatReady = ready.some((provider) =>
    provider.capabilities.some((c) => c.capability === Capability.GENERAL_CHAT));
  if (!generalChatReady) {
    log.warn(
      `no ready provider for ${Capability.GENERAL_CHAT}: chat will reply "AI not configured" until the Claude CLI is installed and logged in, or Ollama is running with the configured model`,
    );
  }
  return {
    ready: ready.map((provider) => provider.id),
    notReady: notReady.map((provider) => provider.id),
    generalChatReady,
  };
}

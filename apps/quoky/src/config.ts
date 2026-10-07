import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CLAUDE_MODEL, ollamaModelExecutionLocality } from '@quoky/ai-cli';
import { AgentProfileRegistry, agentProfileId, isAgentProfileId } from '@quoky/core';
import type { AgentProfile, ContextBuilderConfig, RepositoryIdentityConfig } from '@quoky/core';
import { parseProviderRoutingMode } from './provider-routing/provider-routing-activation';
import type { ProviderRoutingMode } from './provider-routing/provider-routing-activation';
import { ContinuationReceiverActivationError, ContinuationReceiverActivationErrorCode, parseContinuationReceiverMode } from './continuation/continuation-receiver-activation';
import type { ContinuationReceiverMode } from './continuation/continuation-receiver-activation';
import { parseReminderConfig, ReminderConfigErrorCode } from './reminders/reminder-config';
import type { ReminderConfig } from './reminders/reminder-config';

/**
 * Reads runtime configuration from the environment. QUOKY_* takes precedence over
 * the corresponding legacy CHUNSIK_* alias, including an explicitly empty value. This is the ONLY place
 * env vars are read; everything downstream receives typed config objects.
 */
export interface QuokyConfig {
  /**
   * `ownerIds` / `channelIds` are the Personal-edition admission gate (ADR-0091), consumed ONLY by the Discord
   * adapter via the composition root; Core never receives them. `ownerIds` is non-empty (startup error
   * otherwise). An empty `channelIds` admits owner direct messages only.
   */
  discord: {
    token: string;
    guildId?: string;
    ownerIds: string[];
    channelIds: string[];
    /**
     * ADR-0102 D5 (`QUOKY_DISCORD_EXPECTED_BOT_ID`): the bot user id this runtime must connect as. When set, startup
     * compares the connected bot, `guildId` and every `channelIds` entry before the reminder tick starts; a
     * mismatch stops the process. Required when the launchd launcher runs (`host.launcher`).
     */
    expectedBotId?: string;
  };
  /**
   * ADR-0102 always-on host runtime (SUB-1). Both values are written by `ops/launchd/quoky-launch.sh`, never by
   * the owner's `.env.local`: `launcher` is `'launchd'` under the launcher (`QUOKY_LAUNCHER`), and `recentStarts` is
   * the launcher's count of starts in the last 10 minutes (`QUOKY_LAUNCHER_RECENT_STARTS`, 0 outside the launcher;
   * the seam for the SUB-2 crash-loop `OPS_NOTICE`, no consumer yet).
   */
  host: { launcher?: 'launchd'; recentStarts: number };
  storage: { dbPath: string };
  vector: { storePath: string };
  workspace: { workspaceRoot: string };
  /**
   * `claudeModel` is validated at parse (ADR-0092). `ollamaEnabled` controls composition-root registration only
   * (default on, opt-out) and is never inferred from `OLLAMA_MODEL`.
   */
  ai: {
    claudeBin: string;
    claudeModel: string;
    codexBin: string;
    ollamaBin: string;
    ollamaModel: string;
    ollamaEnabled: boolean;
  };
  /**
   * Image understanding provider selection (ADR-0111 D4/D5 and its 2026-10-07 amendment A1/A2). Exactly one provider is
   * registered for `IMAGE_UNDERSTANDING`, or none. See {@link parseImageUnderstandingConfig}.
   */
  imageUnderstanding: ImageUnderstandingConfig;
  /** Personal-edition git safety (ADR-0094). `remoteEnabled` defaults to false (push/sync refused). */
  git: { remoteEnabled: boolean; mergeEnabled: boolean };
  /**
   * Personal v2 inert configuration (ADR-0096 D9, parsed once in wave 1; no consumer yet). Parsing a variable
   * authorizes no behaviour; semantics belong to the track ADRs.
   * `work.summaryEnabled` (`QUOKY_WORK_SUMMARY_ENABLED`, default true; ADR-0100).
   */
  work: { summaryEnabled: boolean };
  /** `QUOKY_REMINDERS_ENABLED`, `QUOKY_REMINDERS_CHANNEL_DELIVERY`, `QUOKY_TIMEZONE` (ADR-0101; reminders default on per ADR-0102 D9, channel delivery default off). */
  reminders: ReminderConfig;
  /**
   * Opt-in local embedding recall (ADR-0098 D8). `model` is a bounded token and never a cloud-served model.
   * `timeoutMs` bounds one embedding call; `maxNewPerTurn` is fixed at 4.
   */
  embedding: { enabled: boolean; model: string; timeoutMs: number; maxNewPerTurn: number };
  /**
   * Owner-curated learning (ADR-0107). `examplesEnabled` (`QUOKY_LEARNING_EXAMPLES_ENABLED`, exact true/false,
   * default false — owner decision 5) gates the LRN-2 curated-example layer only; LRN-1 parses it and no consumer
   * reads it yet. The learning commands themselves are always available: they store text only on an explicit owner
   * command per item, `LOCAL_ONLY`.
   */
  learning: { examplesEnabled: boolean };
  /**
   * ADR-0106 amendment: `archiveDays` (`QUOKY_MEMORY_ARCHIVE_DAYS`, integer 0–365, default 7) is how long a forgotten
   * memory stays restorable in the archive before the daily maintenance deletes it; `0` deletes at once.
   */
  memory: { archiveDays: number };
  /**
   * Local operations UI (ADR-0113 D1–D3). OPS-1 parsed these keys in `ops-ui/ops-ui-config.ts`; OPS-2b folds them here
   * with the same meaning. New `QUOKY_*` keys with no `CHUNSIK_*` alias:
   * - `QUOKY_OPS_UI_ENABLED`: exactly `true` or `false`; default `false` (no port is opened).
   * - `QUOKY_OPS_UI_PORT`: an integer 1024–65535; default `47613`.
   * There is deliberately no bind-address key (the listener binds `127.0.0.1` only). Unlike the other keys, an invalid
   * value is NOT a startup error: it disables only the UI (fail closed) and `invalid` carries the code the wiring logs,
   * never the configured value.
   */
  opsUi: OpsUiFlags;
  connectors: {
    jira?: { host: string; email: string; apiToken: string };
    slack?: { token: string };
    /**
     * `email` selects Atlassian Cloud Basic auth (`email:apiToken`); absent → Bearer (Data Center PAT). See
     * `resolveConfluenceConnector` for the Jira-email reuse rule.
     */
    confluence?: { host: string; token: string; email?: string };
  };
  /**
   * Connector writes (ADR-0112 D4, ADR-0110 amendment D7; CWR-1). Parsed and validated here; the writers are built only
   * when their flag is on and their allowlist is non-empty (`connector-writers-provider.ts`), and the chat flow that
   * uses them is CWR-2. Off by default.
   * - `enabled` (`QUOKY_CONNECTOR_WRITES_ENABLED`, exact true/false, default false) gates Jira and Slack writes.
   * - `jiraProjects` (`QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS`, comma-separated project keys): the Jira write allowlist;
   *   Jira writes reuse the read connector's Atlassian credentials (that token already permits writes).
   * - `slack` (`QUOKY_CONNECTOR_WRITE_SLACK_TOKEN` + `QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS`): a BOT token with
   *   `chat:write`, separate from the read token, and the channel allowlist (`name:ID` or `ID` entries). `undefined`
   *   unless both are set.
   * - `calendarEnabled` (`QUOKY_CALENDAR_WRITE_ENABLED`, exact true/false, default false) gates every calendar write on
   *   the primary calendar, independently of `enabled`; it needs the calendar to be configured with a
   *   `calendar.events` grant.
   * Secrets here are passed only to the adapters and are never logged.
   */
  connectorWrites: {
    enabled: boolean;
    jiraProjects: string[];
    slack?: { token: string; channels: Array<{ id: string; name?: string }> };
    calendarEnabled: boolean;
  };
  /**
   * Read-only calendar (ADR-0110 D2, CAL-1). `undefined` unless the Google OAuth client id, client secret and a refresh
   * token source are all set (partial configuration is "not configured", never a startup error). The refresh token
   * comes from `QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN` (inline) or `QUOKY_CALENDAR_GOOGLE_TOKEN_FILE` (a mode-600 file the
   * consent helper wrote, read by the composition root); setting both is a conflict the composition root refuses.
   * `calendarIds` (`QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS`, comma-separated, default `primary`) is validated by the
   * adapter. `timeZone` is `QUOKY_TIMEZONE` (the reminder zone). Secrets here are passed only to the adapter and are
   * never logged.
   */
  calendar?: {
    google: {
      clientId: string;
      clientSecret: string;
      refreshToken?: string;
      tokenFile?: string;
      calendarIds: string[];
    };
    timeZone: string;
  };
  /**
   * Repository identity for hosting operations (Sprint 3d-A, ADR-0051). RAW/unvalidated here; validated by
   * `RepositoryIdentityResolver` at the composition root. `undefined` when unset (the safe missing path).
   * `provider` is FIXED to `'github'`. Owner/repo prefer the NEW `QUOKY_GITHUB_OWNER`/`QUOKY_GITHUB_REPO`
   * (Sprint 4b, ADR-0061) and fall back to legacy `CHUNSIK_GITHUB_OWNER`/`CHUNSIK_GITHUB_REPO`.
   */
  repositoryHosting?: RepositoryIdentityConfig;
  /**
   * Dev-only PAT for the RepositoryHosting adapter (Sprint 3d-D, ADR-0054; `QUOKY_GITHUB_TOKEN`, with legacy `CHUNSIK_GITHUB_TOKEN` fallback).
   * Adapter-local: never enters `@quoky/core`, `ConversationRuntime`, an anchor, a reason, a response, or a log.
   * Per ADR-0061 (§13), the PAT path is **dev-only** — rejected in a non-dev runtime by the composition root.
   */
  githubToken?: string;
  /**
   * GitHub App auth (Sprint 4b, ADR-0061) — adapter-local. `appId` (non-secret) + `privateKeyPem` (SECRET,
   * resolved from `QUOKY_GITHUB_APP_PRIVATE_KEY` or the file at `QUOKY_GITHUB_APP_PRIVATE_KEY_PATH`). The private
   * key is passed ONLY to `@quoky/github-app-auth` at the composition root; it never enters `@quoky/core`,
   * `ConversationRuntime`, an anchor, an approval reason, a response, or a log. `undefined` when appId or key is
   * absent → App auth is "not configured" (fail-safe).
   */
  githubApp?: { appId: string; privateKeyPem: string };
  /** Optional explicit installation id (`QUOKY_GITHUB_APP_INSTALLATION_ID`) — skips owner/repo resolution. */
  githubAppInstallationId?: number;
  /**
   * Runtime mode gating the dev-only PAT fallback (Sprint 4b, ADR-0061 §10.2). Explicit `QUOKY_RUNTIME_ENV`
   * (`'dev'`/`'prod'`) wins; otherwise derived from `NODE_ENV` (`production` → `'prod'`, else `'dev'`).
   */
  runtimeEnv: 'dev' | 'prod';
  /** Dormant Stage 2B routing activation. Missing is exactly equivalent to `legacy`. */
  providerRoutingMode: ProviderRoutingMode;
  /**
   * §31 continuation receiver activation mode, kept SEPARATE from `providerRoutingMode`. Missing is
   * exactly equivalent to `disabled`: no production ProviderBackedContinuationReceiver binding, no
   * receiver-execution composition, no external continuation trigger. `general-chat-v1` still fails
   * closed at startup because R3 containment is not implemented.
   */
  continuationReceiverMode: ContinuationReceiverMode;
  /** GENERAL_CHAT context selection policy, consumed only by the composition root. */
  contextBuilder: ContextBuilderConfig;
  /**
   * Non-secret, operator-owned links from an existing Discord Actor to personal-work identities.
   * Parsed and validated at the application boundary; credentials and connector tenancy do not belong here.
   */
  actorIdentityMappings: ActorIdentityMapping[];
  /**
   * ADR-0089 static AgentProfile configuration (`QUOKY_AGENT_PROFILES`). Non-secret, composition-time,
   * immutable persona configuration only: it is not an Actor, Provider, aggregate, capability grant, Tool
   * authority or standing execution permission, and it selects no Provider. Absent or blank yields an empty
   * list, so continuation stays fail-closed exactly as before. Validated here against canonical domain rules;
   * the composition root freezes it into the single `AgentProfileRegistry` snapshot.
   */
  agentProfiles: AgentProfile[];
}

export interface ActorIdentityMapping {
  actor: { platform: 'discord'; externalId: string };
  identities: { jira?: string; github?: string };
}

/** Stable, value-free startup error codes for the Personal-edition settings (never echo a configured value). */
export const QuokyConfigErrorCode = {
  DISCORD_OWNER_IDS_MISSING: 'DISCORD_OWNER_IDS_MISSING',
  DISCORD_OWNER_IDS_INVALID: 'DISCORD_OWNER_IDS_INVALID',
  DISCORD_CHANNEL_IDS_INVALID: 'DISCORD_CHANNEL_IDS_INVALID',
  OLLAMA_ENABLED_INVALID: 'OLLAMA_ENABLED_INVALID',
  CLAUDE_MODEL_INVALID: 'CLAUDE_MODEL_INVALID',
  GIT_REMOTE_ENABLED_INVALID: 'GIT_REMOTE_ENABLED_INVALID',
  GIT_MERGE_ENABLED_INVALID: 'GIT_MERGE_ENABLED_INVALID',
  GIT_MERGE_REQUIRES_REMOTE: 'GIT_MERGE_REQUIRES_REMOTE',
  WORK_SUMMARY_ENABLED_INVALID: 'WORK_SUMMARY_ENABLED_INVALID',
  EMBEDDING_ENABLED_INVALID: 'EMBEDDING_ENABLED_INVALID',
  EMBEDDING_MODEL_INVALID: 'EMBEDDING_MODEL_INVALID',
  EMBEDDING_MODEL_CLOUD_REFUSED: 'EMBEDDING_MODEL_CLOUD_REFUSED',
  EMBEDDING_TIMEOUT_INVALID: 'EMBEDDING_TIMEOUT_INVALID',
  LEARNING_EXAMPLES_ENABLED_INVALID: 'LEARNING_EXAMPLES_ENABLED_INVALID',
  MEMORY_ARCHIVE_DAYS_INVALID: 'MEMORY_ARCHIVE_DAYS_INVALID',
  ...ReminderConfigErrorCode,
  CONTEXT_MAX_TOKENS_INVALID: 'CONTEXT_MAX_TOKENS_INVALID',
  DISCORD_EXPECTED_BOT_ID_INVALID: 'DISCORD_EXPECTED_BOT_ID_INVALID',
  DISCORD_EXPECTED_BOT_ID_REQUIRED: 'DISCORD_EXPECTED_BOT_ID_REQUIRED',
  LAUNCHER_INVALID: 'LAUNCHER_INVALID',
  CONNECTOR_WRITES_ENABLED_INVALID: 'CONNECTOR_WRITES_ENABLED_INVALID',
  CONNECTOR_WRITE_JIRA_PROJECTS_INVALID: 'CONNECTOR_WRITE_JIRA_PROJECTS_INVALID',
  CONNECTOR_WRITE_SLACK_CHANNELS_INVALID: 'CONNECTOR_WRITE_SLACK_CHANNELS_INVALID',
  CONNECTOR_WRITE_SLACK_TOKEN_INVALID: 'CONNECTOR_WRITE_SLACK_TOKEN_INVALID',
  CONNECTOR_WRITE_SLACK_TOKEN_NOT_SEPARATE: 'CONNECTOR_WRITE_SLACK_TOKEN_NOT_SEPARATE',
  CALENDAR_WRITE_ENABLED_INVALID: 'CALENDAR_WRITE_ENABLED_INVALID',
  IMAGE_UNDERSTANDING_PROVIDER_INVALID: 'IMAGE_UNDERSTANDING_PROVIDER_INVALID',
  IMAGE_UNDERSTANDING_MODEL_INVALID: 'IMAGE_UNDERSTANDING_MODEL_INVALID',
  IMAGE_UNDERSTANDING_OLLAMA_MODEL_MISSING: 'IMAGE_UNDERSTANDING_OLLAMA_MODEL_MISSING',
  IMAGE_UNDERSTANDING_OLLAMA_MODEL_INVALID: 'IMAGE_UNDERSTANDING_OLLAMA_MODEL_INVALID',
  IMAGE_UNDERSTANDING_OLLAMA_MODEL_NOT_LOCAL: 'IMAGE_UNDERSTANDING_OLLAMA_MODEL_NOT_LOCAL',
} as const;
export type QuokyConfigErrorCode = (typeof QuokyConfigErrorCode)[keyof typeof QuokyConfigErrorCode];

/**
 * A fail-closed startup configuration error. The message is the code only (no configured value).
 * Note: loadConfig can also throw ReminderConfigError (reminders/reminder-config.ts, kept separate to avoid an
 * import cycle). Match on `code`/message (as describeStartupFailure does), not `instanceof QuokyConfigError`.
 */
export class QuokyConfigError extends Error {
  constructor(readonly code: QuokyConfigErrorCode) {
    super(code);
    this.name = 'QuokyConfigError';
  }
}

/** Repository root (apps/quoky/{src,dist} -> repo), so relative data paths never depend on process.cwd(). */
const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');

/** Default GENERAL_CHAT context budget in ESTIMATED tokens (ContextBuilder `maxTokens`). */
const DEFAULT_CONTEXT_MAX_TOKENS = 6000;
const MAX_CONTEXT_MAX_TOKENS = 200_000;

/** Local embedding defaults (ADR-0098 D8): the model is pulled manually by the owner; never pulled or cloud-served. */
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_EMBEDDING_TIMEOUT_MS = 3000;
const MIN_EMBEDDING_TIMEOUT_MS = 100;
const MAX_EMBEDDING_TIMEOUT_MS = 30_000;
const EMBEDDING_MAX_NEW_PER_TURN = 4;

/** ADR-0106 amendment: the memory archive retention (days). Mirrors the core service's bounds. */
const DEFAULT_MEMORY_ARCHIVE_DAYS = 7;

/** ADR-0113 D2: the operations UI port (loopback only) and its bounds. */
export const OPS_UI_DEFAULT_PORT = 47613;
export const OPS_UI_MIN_PORT = 1024;
export const OPS_UI_MAX_PORT = 65535;

export const OpsUiConfigErrorCode = {
  OPS_UI_ENABLED_INVALID: 'OPS_UI_ENABLED_INVALID',
  OPS_UI_PORT_INVALID: 'OPS_UI_PORT_INVALID',
} as const;
export type OpsUiConfigErrorCode = (typeof OpsUiConfigErrorCode)[keyof typeof OpsUiConfigErrorCode];

export type OpsUiFlags =
  | { readonly enabled: false; readonly invalid?: OpsUiConfigErrorCode }
  | { readonly enabled: true; readonly port: number };

/** `QUOKY_OPS_UI_ENABLED` / `QUOKY_OPS_UI_PORT` (ADR-0113 D1/D2): an invalid value disables only the UI, with a code. */
export function parseOpsUiFlags(env: NodeJS.ProcessEnv): OpsUiFlags {
  const rawEnabled = env.QUOKY_OPS_UI_ENABLED;
  if (rawEnabled === undefined || rawEnabled === '' || rawEnabled === 'false') return { enabled: false };
  if (rawEnabled !== 'true') return { enabled: false, invalid: OpsUiConfigErrorCode.OPS_UI_ENABLED_INVALID };
  const rawPort = env.QUOKY_OPS_UI_PORT;
  let port = OPS_UI_DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    if (!/^[0-9]{1,5}$/.test(rawPort)) return { enabled: false, invalid: OpsUiConfigErrorCode.OPS_UI_PORT_INVALID };
    port = Number(rawPort);
    if (port < OPS_UI_MIN_PORT || port > OPS_UI_MAX_PORT) {
      return { enabled: false, invalid: OpsUiConfigErrorCode.OPS_UI_PORT_INVALID };
    }
  }
  return { enabled: true, port };
}
const MAX_MEMORY_ARCHIVE_DAYS = 365;

/** `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` values (exact, lowercase). */
export const IMAGE_UNDERSTANDING_PROVIDERS = ['ollama', 'claude', 'off'] as const;
export type ImageUnderstandingProviderSelection = (typeof IMAGE_UNDERSTANDING_PROVIDERS)[number];

/**
 * Codes of the legacy implicit path only (`QUOKY_IMAGE_UNDERSTANDING_PROVIDER` unset, `QUOKY_OLLAMA_VISION_MODEL` set):
 * as before the selector existed, an unusable vision model disables image understanding (fail closed) and the
 * composition logs the code — it never stops Quoky and is never echoed.
 */
export const ImageUnderstandingConfigErrorCode = {
  VISION_MODEL_INVALID: 'OLLAMA_VISION_MODEL_INVALID',
  VISION_MODEL_NOT_LOCAL: 'OLLAMA_VISION_MODEL_NOT_LOCAL',
} as const;
export type ImageUnderstandingConfigErrorCode =
  (typeof ImageUnderstandingConfigErrorCode)[keyof typeof ImageUnderstandingConfigErrorCode];

export type ImageUnderstandingConfig =
  | { readonly provider: 'off'; readonly invalid?: ImageUnderstandingConfigErrorCode }
  /** A local Ollama vision model (`LOCAL`); image bytes never leave this host. */
  | { readonly provider: 'ollama'; readonly model: string }
  /** The Claude CLI (`REMOTE`): the owner's explicit cloud opt-in (ADR-0111 amendment A1). */
  | { readonly provider: 'claude'; readonly model: string };

const OLLAMA_VISION_MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const CLAUDE_MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;

/**
 * ADR-0111 amendment A1 (owner decision 2026-10-07). `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` = `ollama` | `claude` | `off`
 * (exact; anything else, including an empty value, is the startup error `IMAGE_UNDERSTANDING_PROVIDER_INVALID`).
 * - Unset: `ollama` when `QUOKY_OLLAMA_VISION_MODEL` is set, otherwise `off` — exactly the behaviour before the
 *   selector. On this implicit path an unusable vision model keeps its old fail-closed, non-fatal handling.
 * - `ollama`: `QUOKY_OLLAMA_VISION_MODEL` is required and must be a plain local model name; a missing, malformed or
 *   cloud-served (`*cloud*`) model is a startup error (an explicit selection fails loudly).
 * - `claude`: the Claude CLI reads images in the cloud. The model is `QUOKY_IMAGE_UNDERSTANDING_MODEL` when set, else
 *   `QUOKY_CLAUDE_MODEL`, else `sonnet`; a malformed `QUOKY_IMAGE_UNDERSTANDING_MODEL` is
 *   `IMAGE_UNDERSTANDING_MODEL_INVALID`. `QUOKY_IMAGE_UNDERSTANDING_MODEL` is read only for `claude`.
 * - `off`: no image provider; every image turn gets the truthful "unavailable" reply.
 */
export function parseImageUnderstandingConfig(
  env: NodeJS.ProcessEnv,
  claudeModel: string = parseClaudeModel(env.QUOKY_CLAUDE_MODEL),
): ImageUnderstandingConfig {
  const raw = env.QUOKY_IMAGE_UNDERSTANDING_PROVIDER;
  const visionModel = env.QUOKY_OLLAMA_VISION_MODEL?.trim() ?? '';
  if (raw === undefined) {
    if (visionModel === '') return { provider: 'off' };
    if (!OLLAMA_VISION_MODEL_SHAPE.test(visionModel)) {
      return { provider: 'off', invalid: ImageUnderstandingConfigErrorCode.VISION_MODEL_INVALID };
    }
    if (ollamaModelExecutionLocality(visionModel) !== 'LOCAL') {
      return { provider: 'off', invalid: ImageUnderstandingConfigErrorCode.VISION_MODEL_NOT_LOCAL };
    }
    return { provider: 'ollama', model: visionModel };
  }
  if (!(IMAGE_UNDERSTANDING_PROVIDERS as readonly string[]).includes(raw)) {
    throw new QuokyConfigError(QuokyConfigErrorCode.IMAGE_UNDERSTANDING_PROVIDER_INVALID);
  }
  const selection = raw as ImageUnderstandingProviderSelection;
  if (selection === 'off') return { provider: 'off' };
  if (selection === 'ollama') {
    if (visionModel === '') throw new QuokyConfigError(QuokyConfigErrorCode.IMAGE_UNDERSTANDING_OLLAMA_MODEL_MISSING);
    if (!OLLAMA_VISION_MODEL_SHAPE.test(visionModel)) {
      throw new QuokyConfigError(QuokyConfigErrorCode.IMAGE_UNDERSTANDING_OLLAMA_MODEL_INVALID);
    }
    if (ollamaModelExecutionLocality(visionModel) !== 'LOCAL') {
      throw new QuokyConfigError(QuokyConfigErrorCode.IMAGE_UNDERSTANDING_OLLAMA_MODEL_NOT_LOCAL);
    }
    return { provider: 'ollama', model: visionModel };
  }
  const own = env.QUOKY_IMAGE_UNDERSTANDING_MODEL;
  if (own === undefined) return { provider: 'claude', model: claudeModel };
  if (!CLAUDE_MODEL_SHAPE.test(own)) throw new QuokyConfigError(QuokyConfigErrorCode.IMAGE_UNDERSTANDING_MODEL_INVALID);
  return { provider: 'claude', model: own };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): QuokyConfig {
  const continuationReceiverMode = parseContinuationReceiverMode(env.QUOKY_CONTINUATION_RECEIVER_MODE);
  // R2 production has no live containment. The offline activation factory is not AppModule wiring.
  if (continuationReceiverMode === 'general-chat-v1') {
    throw new ContinuationReceiverActivationError(
      ContinuationReceiverActivationErrorCode.CONTAINMENT_UNAVAILABLE,
    );
  }
  const gitRemoteEnabled = parseExactBoolean(
    env.QUOKY_GIT_REMOTE_ENABLED,
    false,
    QuokyConfigErrorCode.GIT_REMOTE_ENABLED_INVALID,
  );
  const gitMergeEnabled = parseExactBoolean(
    env.QUOKY_GIT_MERGE_ENABLED,
    false,
    QuokyConfigErrorCode.GIT_MERGE_ENABLED_INVALID,
  );
  // Merge needs the remote: enabling it while remote access is off is a startup error, never a silent no-op.
  if (gitMergeEnabled && !gitRemoteEnabled) throw new QuokyConfigError(QuokyConfigErrorCode.GIT_MERGE_REQUIRES_REMOTE);
  // Owner/repo prefer the new QUOKY_* env, falling back to legacy CHUNSIK_* (Sprint 4b, ADR-0061 N3/N4).
  const owner = env.QUOKY_GITHUB_OWNER ?? env.CHUNSIK_GITHUB_OWNER;
  const repo = env.QUOKY_GITHUB_REPO ?? env.CHUNSIK_GITHUB_REPO;
  // ADR-0091: fail closed before anything else is composed when no owner is configured.
  const ownerIds = parseDiscordIdList(env.QUOKY_DISCORD_OWNER_IDS, QuokyConfigErrorCode.DISCORD_OWNER_IDS_INVALID);
  if (ownerIds.length === 0) throw new QuokyConfigError(QuokyConfigErrorCode.DISCORD_OWNER_IDS_MISSING);
  // ADR-0102 D5: the launcher-run service must name the bot it expects to connect as.
  const host = parseHostRuntime(env);
  const expectedBotId = parseExpectedBotId(env.QUOKY_DISCORD_EXPECTED_BOT_ID);
  if (host.launcher === 'launchd' && expectedBotId === undefined) {
    throw new QuokyConfigError(QuokyConfigErrorCode.DISCORD_EXPECTED_BOT_ID_REQUIRED);
  }

  const reminders = parseReminderConfig(env);
  const calendar = resolveCalendar(env, reminders.timeZone);
  const claudeModel = parseClaudeModel(env.QUOKY_CLAUDE_MODEL);

  return {
    discord: {
      token: env.DISCORD_BOT_TOKEN ?? '',
      guildId: env.DISCORD_GUILD_ID,
      ownerIds,
      channelIds: parseDiscordIdList(env.QUOKY_DISCORD_CHANNEL_IDS, QuokyConfigErrorCode.DISCORD_CHANNEL_IDS_INVALID),
      ...(expectedBotId !== undefined ? { expectedBotId } : {}),
    },
    host,
    storage: { dbPath: resolveDataPath(env.QUOKY_DB_PATH ?? env.CHUNSIK_DB_PATH ?? './data/chunsik.db') },
    vector: { storePath: resolveDataPath(env.QUOKY_VECTOR_PATH ?? env.CHUNSIK_VECTOR_PATH ?? './data/vectors') },
    workspace: { workspaceRoot: env.QUOKY_WORKSPACE_ROOT ?? env.CHUNSIK_WORKSPACE_ROOT ?? process.cwd() },
    ai: {
      claudeBin: env.CLAUDE_CLI_BIN ?? 'claude',
      claudeModel,
      codexBin: env.CODEX_CLI_BIN ?? 'codex',
      ollamaBin: env.OLLAMA_CLI_BIN ?? 'ollama',
      ollamaModel: env.OLLAMA_MODEL ?? 'llama3.1',
      // Registration flag only (ADR-0092): opt-out, exact true/false, never inferred from OLLAMA_MODEL.
      ollamaEnabled: parseExactBoolean(env.QUOKY_OLLAMA_ENABLED, true, QuokyConfigErrorCode.OLLAMA_ENABLED_INVALID),
    },
    imageUnderstanding: parseImageUnderstandingConfig(env, claudeModel),
    git: { remoteEnabled: gitRemoteEnabled, mergeEnabled: gitMergeEnabled },
    work: {
      summaryEnabled: parseExactBoolean(
        env.QUOKY_WORK_SUMMARY_ENABLED,
        true,
        QuokyConfigErrorCode.WORK_SUMMARY_ENABLED_INVALID,
      ),
    },
    reminders,
    embedding: {
      enabled: parseExactBoolean(env.QUOKY_EMBEDDING_ENABLED, false, QuokyConfigErrorCode.EMBEDDING_ENABLED_INVALID),
      model: parseEmbeddingModel(env.QUOKY_EMBEDDING_MODEL),
      timeoutMs: parseEmbeddingTimeoutMs(env.QUOKY_EMBEDDING_TIMEOUT_MS),
      maxNewPerTurn: EMBEDDING_MAX_NEW_PER_TURN,
    },
    learning: {
      examplesEnabled: parseExactBoolean(
        env.QUOKY_LEARNING_EXAMPLES_ENABLED,
        false,
        QuokyConfigErrorCode.LEARNING_EXAMPLES_ENABLED_INVALID,
      ),
    },
    memory: { archiveDays: parseMemoryArchiveDays(env.QUOKY_MEMORY_ARCHIVE_DAYS) },
    opsUi: parseOpsUiFlags(env),
    connectors: {
      jira: resolveJiraConnector(env),
      slack: resolveSlackConnector(env),
      confluence: resolveConfluenceConnector(env),
    },
    connectorWrites: parseConnectorWrites(env),
    ...(calendar !== undefined ? { calendar } : {}),
    // Provider fixed to 'github'. Undefined when both owner and repo are absent; a single one present yields a raw
    // config the resolver classifies (invalid-owner / invalid-repo). No provider/token env var is read here.
    repositoryHosting: owner || repo ? { provider: 'github', owner: owner ?? '', repo: repo ?? '' } : undefined,
    // Sprint 3d-D (legacy): adapter-local dev-only PAT. Undefined when unset.
    githubToken: env.QUOKY_GITHUB_TOKEN ?? env.CHUNSIK_GITHUB_TOKEN,
    // Sprint 4b (ADR-0061): GitHub App auth (adapter-local). Undefined unless BOTH appId and a private key resolve.
    githubApp: resolveGithubApp(env),
    githubAppInstallationId: parseInstallationId(env.QUOKY_GITHUB_APP_INSTALLATION_ID),
    runtimeEnv: resolveRuntimeEnv(env),
    providerRoutingMode: parseProviderRoutingMode(env.QUOKY_PROVIDER_ROUTING_MODE),
    continuationReceiverMode,
    contextBuilder: {
      rankingEnabled: true,
      compressionEnabled: true,
      maxTokens: parseContextMaxTokens(env.QUOKY_CONTEXT_MAX_TOKENS),
      recencyWeight: 0.4,
      relevanceWeight: 0.6,
      compressionConfig: { minimumCharactersPerEntry: 80 },
    },
    actorIdentityMappings: parseActorIdentityMappings(env.QUOKY_ACTOR_IDENTITY_MAPPINGS),
    agentProfiles: parseAgentProfiles(env.QUOKY_AGENT_PROFILES),
  };
}

/** Discord snowflakes are decimal strings of 17-20 digits. */
const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/;

/**
 * ADR-0102: the env file the launchd launcher passes (`QUOKY_ENV_FILE`, an absolute path to the host's `.env.local`).
 * `undefined` outside the launcher, which keeps the repository `.env.local` default. Read before `.env.local` loads,
 * so it can only come from the process environment the launcher built.
 */
export function resolveEnvFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.QUOKY_ENV_FILE;
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/** Unset/blank → undefined; otherwise exactly one Discord snowflake (never echoed on error). */
function parseExpectedBotId(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = raw.trim();
  if (!DISCORD_SNOWFLAKE.test(value)) throw new QuokyConfigError(QuokyConfigErrorCode.DISCORD_EXPECTED_BOT_ID_INVALID);
  return value;
}

/** Launcher-written values only: `QUOKY_LAUNCHER` is unset or exactly `launchd`; the start count is 0-9999. */
function parseHostRuntime(env: NodeJS.ProcessEnv): QuokyConfig['host'] {
  const launcher = env.QUOKY_LAUNCHER;
  if (launcher !== undefined && launcher !== 'launchd') throw new QuokyConfigError(QuokyConfigErrorCode.LAUNCHER_INVALID);
  const rawStarts = env.QUOKY_LAUNCHER_RECENT_STARTS;
  if (rawStarts !== undefined && !/^[0-9]{1,4}$/.test(rawStarts)) {
    throw new QuokyConfigError(QuokyConfigErrorCode.LAUNCHER_INVALID);
  }
  const recentStarts = rawStarts === undefined ? 0 : Number(rawStarts);
  return launcher === 'launchd' ? { launcher, recentStarts } : { recentStarts };
}
const MAX_DISCORD_ID_ENTRIES = 64;

/**
 * Comma-separated Discord snowflakes. Absent or whitespace-only yields an empty list (the caller decides whether
 * that is an error); any blank entry, non-snowflake entry, or oversized list is a typed error that never echoes
 * the configured value. Duplicates collapse (order preserved).
 */
function parseDiscordIdList(raw: string | undefined, error: QuokyConfigErrorCode): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_DISCORD_ID_ENTRIES) throw new QuokyConfigError(error);
  if (entries.some((entry) => !DISCORD_SNOWFLAKE.test(entry))) throw new QuokyConfigError(error);
  return [...new Set(entries)];
}

/** Exact `true`/`false` only; unset yields the default. Anything else (including empty) is a startup error. */
function parseExactBoolean(raw: string | undefined, defaultValue: boolean, error: QuokyConfigErrorCode): boolean {
  if (raw === undefined) return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new QuokyConfigError(error);
}

/** Bounded alias/model token (same shape the Claude adapter enforces); it becomes a fixed argv element. */
function parseClaudeModel(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_CLAUDE_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(raw)) {
    throw new QuokyConfigError(QuokyConfigErrorCode.CLAUDE_MODEL_INVALID);
  }
  return raw;
}

/** One lowercase Ollama name/tag segment; bounded so it is a safe fixed argv element. */
const EMBEDDING_MODEL_SEGMENT = '[a-z0-9][a-z0-9._-]{0,63}';
const EMBEDDING_MODEL_SHAPE = new RegExp(`^${EMBEDDING_MODEL_SEGMENT}(?::${EMBEDDING_MODEL_SEGMENT})?$`);

/**
 * Bounded `name[:tag]` token (ADR-0096 D9). A name or tag containing `cloud` (any case) is refused with its own
 * typed error so a cloud-served model can never be selected for embeddings (ADR-0098 D8). Unset yields the default.
 */
function parseEmbeddingModel(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_EMBEDDING_MODEL;
  if (raw.toLowerCase().includes('cloud')) {
    throw new QuokyConfigError(QuokyConfigErrorCode.EMBEDDING_MODEL_CLOUD_REFUSED);
  }
  if (!EMBEDDING_MODEL_SHAPE.test(raw)) throw new QuokyConfigError(QuokyConfigErrorCode.EMBEDDING_MODEL_INVALID);
  return raw;
}

/** Bounded positive integer milliseconds for one embedding call; unset yields the default. */
function parseEmbeddingTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EMBEDDING_TIMEOUT_MS;
  if (!/^[0-9]{1,6}$/.test(raw)) throw new QuokyConfigError(QuokyConfigErrorCode.EMBEDDING_TIMEOUT_INVALID);
  const value = Number(raw);
  if (value < MIN_EMBEDDING_TIMEOUT_MS || value > MAX_EMBEDDING_TIMEOUT_MS) {
    throw new QuokyConfigError(QuokyConfigErrorCode.EMBEDDING_TIMEOUT_INVALID);
  }
  return value;
}

/** Whole days 0–365 (plain decimal digits only, like the other bounded integers); unset yields the default (7). */
function parseMemoryArchiveDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MEMORY_ARCHIVE_DAYS;
  if (!/^[0-9]{1,3}$/.test(raw)) throw new QuokyConfigError(QuokyConfigErrorCode.MEMORY_ARCHIVE_DAYS_INVALID);
  const days = Number(raw);
  if (days > MAX_MEMORY_ARCHIVE_DAYS) throw new QuokyConfigError(QuokyConfigErrorCode.MEMORY_ARCHIVE_DAYS_INVALID);
  return days;
}

/** Positive integer count of ESTIMATED tokens, bounded; unset yields the default budget. */
function parseContextMaxTokens(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONTEXT_MAX_TOKENS;
  if (!/^[0-9]{1,7}$/.test(raw)) throw new QuokyConfigError(QuokyConfigErrorCode.CONTEXT_MAX_TOKENS_INVALID);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONTEXT_MAX_TOKENS) {
    throw new QuokyConfigError(QuokyConfigErrorCode.CONTEXT_MAX_TOKENS_INVALID);
  }
  return value;
}

/** Relative data paths resolve against the repository root; empty, absolute and `:memory:` stay unchanged. */
function resolveDataPath(value: string): string {
  if (value === '' || value === ':memory:' || path.isAbsolute(value)) return value;
  return path.resolve(REPOSITORY_ROOT, value);
}

/** Bounded so a malformed or pasted payload cannot become an unbounded startup cost. */
const MAX_AGENT_PROFILE_ENTRIES = 64;
const MAX_AGENT_PROFILES_PAYLOAD_CHARACTERS = 1_048_576;
const AGENT_PROFILE_FIELDS = ['id', 'displayName', 'role', 'purpose', 'instructions'] as const;

/**
 * ADR-0089 static AgentProfile configuration. Fails closed on any malformed input and never echoes the raw
 * payload, `instructions` text or pasted content. Absent/blank is exactly today's empty registry.
 */
function parseAgentProfiles(raw: string | undefined): AgentProfile[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  if (raw.length > MAX_AGENT_PROFILES_PAYLOAD_CHARACTERS) throw new Error('AGENT_PROFILES_PAYLOAD_TOO_LARGE');

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_PROFILES_INVALID_JSON');
  }
  if (!Array.isArray(value)) throw new Error('AGENT_PROFILES_MUST_BE_ARRAY');
  if (value.length > MAX_AGENT_PROFILE_ENTRIES) throw new Error('AGENT_PROFILES_TOO_MANY_ENTRIES');

  const candidates = value.map((entry, index) => parseAgentProfile(entry, index));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // Deterministic identity: no last-wins, first-wins or silent dedupe.
    if (seen.has(candidate.id)) throw new Error(`AGENT_PROFILES_DUPLICATE_ID_${candidate.id}`);
    seen.add(candidate.id);
  }
  // Canonical domain rules (bounded text, control characters, duplicate identity, freezing) stay owned by
  // AgentProfileRegistry; this validating pass keeps the failure at the configuration boundary.
  try {
    return [...new AgentProfileRegistry(candidates).list()];
  } catch (error) {
    throw new Error('AGENT_PROFILES_INVALID', { cause: error });
  }
}

/** Structural validation only: exactly the five existing domain fields, no authority-bearing field. */
function parseAgentProfile(value: unknown, index: number): AgentProfile {
  const entry = requireRecord(value, `AGENT_PROFILE_${index}_INVALID`);
  requireOnlyKeys(entry, AGENT_PROFILE_FIELDS, `AGENT_PROFILE_${index}_UNKNOWN_FIELD`);
  for (const field of AGENT_PROFILE_FIELDS) {
    if (typeof entry[field] !== 'string') {
      throw new Error(`AGENT_PROFILE_${index}_${field.toUpperCase()}_INVALID`);
    }
  }
  // Identity is never trimmed, lowercased or case-folded here; the domain rule decides.
  if (!isAgentProfileId(entry.id)) throw new Error(`AGENT_PROFILE_${index}_ID_INVALID`);
  return {
    id: agentProfileId(entry.id),
    displayName: entry.displayName as string,
    role: entry.role as string,
    purpose: entry.purpose as string,
    instructions: entry.instructions as string,
  };
}

function parseActorIdentityMappings(raw: string | undefined): ActorIdentityMapping[] {
  if (raw === undefined || raw.trim().length === 0) return [];

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('ACTOR_IDENTITY_MAPPINGS_INVALID_JSON');
  }
  if (!Array.isArray(value)) throw new Error('ACTOR_IDENTITY_MAPPINGS_MUST_BE_ARRAY');

  const mappings = value.map((entry, index) => parseActorIdentityMapping(entry, index));
  const configured = new Map<string, string>();
  const assignedTargets = new Map<string, string>();
  for (const mapping of mappings) {
    const locator = `${mapping.actor.platform}\u0000${mapping.actor.externalId}`;
    for (const platform of ['jira', 'github'] as const) {
      const externalId = mapping.identities[platform];
      if (externalId === undefined) continue;
      const platformKey = `${locator}\u0000${platform}`;
      const existing = configured.get(platformKey);
      if (existing !== undefined && existing !== externalId) {
        throw new Error(`ACTOR_IDENTITY_MAPPINGS_CONFLICTING_${platform.toUpperCase()}`);
      }
      configured.set(platformKey, externalId);

      const targetKey = `${platform}\u0000${externalId}`;
      const assigned = assignedTargets.get(targetKey);
      if (assigned !== undefined && assigned !== locator) {
        throw new Error('ACTOR_IDENTITY_MAPPINGS_TARGET_ASSIGNED_TO_MULTIPLE_ACTORS');
      }
      assignedTargets.set(targetKey, locator);
    }
  }
  return mappings;
}

function parseActorIdentityMapping(value: unknown, index: number): ActorIdentityMapping {
  const entry = requireRecord(value, `ACTOR_IDENTITY_MAPPING_${index}_INVALID`);
  requireOnlyKeys(entry, ['actor', 'identities'], `ACTOR_IDENTITY_MAPPING_${index}_UNKNOWN_FIELD`);
  const actor = requireRecord(entry.actor, `ACTOR_IDENTITY_MAPPING_${index}_ACTOR_INVALID`);
  requireOnlyKeys(actor, ['platform', 'externalId'], `ACTOR_IDENTITY_MAPPING_${index}_ACTOR_UNKNOWN_FIELD`);
  if (actor.platform !== 'discord') throw new Error(`ACTOR_IDENTITY_MAPPING_${index}_ACTOR_PLATFORM_INVALID`);
  const actorExternalId = requireNonBlank(actor.externalId, `ACTOR_IDENTITY_MAPPING_${index}_ACTOR_EXTERNAL_ID_INVALID`);

  const identities = requireRecord(entry.identities, `ACTOR_IDENTITY_MAPPING_${index}_IDENTITIES_INVALID`);
  requireOnlyKeys(identities, ['jira', 'github'], `ACTOR_IDENTITY_MAPPING_${index}_IDENTITIES_UNKNOWN_FIELD`);
  const jira = identities.jira === undefined
    ? undefined
    : requireNonBlank(identities.jira, `ACTOR_IDENTITY_MAPPING_${index}_JIRA_INVALID`);
  const github = identities.github === undefined
    ? undefined
    : requireNonBlank(identities.github, `ACTOR_IDENTITY_MAPPING_${index}_GITHUB_INVALID`);
  if (github !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(github)) {
    throw new Error(`ACTOR_IDENTITY_MAPPING_${index}_GITHUB_INVALID`);
  }
  if (jira === undefined && github === undefined) {
    throw new Error(`ACTOR_IDENTITY_MAPPING_${index}_IDENTITIES_EMPTY`);
  }
  return {
    actor: { platform: 'discord', externalId: actorExternalId },
    identities: { ...(jira === undefined ? {} : { jira }), ...(github === undefined ? {} : { github }) },
  };
}

function requireRecord(value: unknown, error: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], error: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(error);
}

function requireNonBlank(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(error);
  return value.trim();
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveJiraConnector(
  env: NodeJS.ProcessEnv,
): { host: string; email: string; apiToken: string } | undefined {
  const host = nonBlank(env.QUOKY_JIRA_BASE_URL ?? env.CHUNSIK_JIRA_BASE_URL);
  const email = nonBlank(env.QUOKY_JIRA_EMAIL ?? env.CHUNSIK_JIRA_EMAIL);
  const apiToken = nonBlank(env.QUOKY_JIRA_TOKEN ?? env.CHUNSIK_JIRA_TOKEN);
  return host && email && apiToken ? { host, email, apiToken } : undefined;
}

function resolveSlackConnector(env: NodeJS.ProcessEnv): { token: string } | undefined {
  const token = nonBlank(env.QUOKY_SLACK_TOKEN ?? env.CHUNSIK_SLACK_TOKEN);
  return token ? { token } : undefined;
}

/** Jira project keys (ADR-0112 D4 allowlist). */
const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Slack channel ids and lowercase channel names (ADR-0112 D4 allowlist). */
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{8,20}$/;
const SLACK_CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** Built by concatenation so no token-shaped literal appears in the source. */
const SLACK_BOT_TOKEN_PREFIX = 'xox' + 'b-';
const CONNECTOR_WRITE_ALLOWLIST_MAX = 50;

/** See `QuokyConfig.connectorWrites`. Every value is validated even while writes are off (fail closed, value-free). */
function parseConnectorWrites(env: NodeJS.ProcessEnv): QuokyConfig['connectorWrites'] {
  const enabled = parseExactBoolean(
    env.QUOKY_CONNECTOR_WRITES_ENABLED,
    false,
    QuokyConfigErrorCode.CONNECTOR_WRITES_ENABLED_INVALID,
  );
  const calendarEnabled = parseExactBoolean(
    env.QUOKY_CALENDAR_WRITE_ENABLED,
    false,
    QuokyConfigErrorCode.CALENDAR_WRITE_ENABLED_INVALID,
  );
  const jiraProjects = parseAllowlist(env.QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS, QuokyConfigErrorCode.CONNECTOR_WRITE_JIRA_PROJECTS_INVALID)
    .map((entry) => {
      if (!JIRA_PROJECT_KEY.test(entry)) throw new QuokyConfigError(QuokyConfigErrorCode.CONNECTOR_WRITE_JIRA_PROJECTS_INVALID);
      return entry;
    });
  if (new Set(jiraProjects).size !== jiraProjects.length) {
    throw new QuokyConfigError(QuokyConfigErrorCode.CONNECTOR_WRITE_JIRA_PROJECTS_INVALID);
  }
  const channels = parseSlackWriteChannels(env.QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS);
  const token = nonBlank(env.QUOKY_CONNECTOR_WRITE_SLACK_TOKEN);
  if (token !== undefined) {
    if (!token.startsWith(SLACK_BOT_TOKEN_PREFIX) || token.length <= SLACK_BOT_TOKEN_PREFIX.length) {
      throw new QuokyConfigError(QuokyConfigErrorCode.CONNECTOR_WRITE_SLACK_TOKEN_INVALID);
    }
    // ADR-0112 D4: the write token is separate from the read token.
    if (token === resolveSlackConnector(env)?.token) {
      throw new QuokyConfigError(QuokyConfigErrorCode.CONNECTOR_WRITE_SLACK_TOKEN_NOT_SEPARATE);
    }
  }
  return {
    enabled,
    jiraProjects,
    ...(token !== undefined && channels.length > 0 ? { slack: { token, channels } } : {}),
    calendarEnabled,
  };
}

/** Comma-separated, trimmed, non-empty entries; unset or blank is an empty list; more than 50 entries is an error. */
function parseAllowlist(raw: string | undefined, error: QuokyConfigErrorCode): string[] {
  const value = nonBlank(raw);
  if (value === undefined) return [];
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0) || entries.length > CONNECTOR_WRITE_ALLOWLIST_MAX) {
    throw new QuokyConfigError(error);
  }
  return entries;
}

/** `name:ID` or `ID` entries (a leading `#` on the name is allowed); ids and names must be unique. */
function parseSlackWriteChannels(raw: string | undefined): Array<{ id: string; name?: string }> {
  const error = QuokyConfigErrorCode.CONNECTOR_WRITE_SLACK_CHANNELS_INVALID;
  const channels = parseAllowlist(raw, error).map((entry) => {
    const separator = entry.lastIndexOf(':');
    const id = (separator === -1 ? entry : entry.slice(separator + 1)).trim();
    const rawName = separator === -1 ? undefined : entry.slice(0, separator).trim();
    const name = rawName === undefined ? undefined : rawName.startsWith('#') ? rawName.slice(1) : rawName;
    if (!SLACK_CHANNEL_ID.test(id)) throw new QuokyConfigError(error);
    if (name !== undefined && !SLACK_CHANNEL_NAME.test(name)) throw new QuokyConfigError(error);
    return name === undefined ? { id } : { id, name };
  });
  const ids = channels.map((channel) => channel.id);
  const names = channels.flatMap((channel) => (channel.name === undefined ? [] : [channel.name]));
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) throw new QuokyConfigError(error);
  return channels;
}

/**
 * The Google OAuth client for the calendar adapter and its consent helper (ADR-0110 D2): a "Desktop app" client from
 * the owner's Google Cloud project. `undefined` unless both values are non-blank. Never logged.
 */
export function resolveGoogleCalendarOAuthClient(
  env: NodeJS.ProcessEnv,
): { clientId: string; clientSecret: string } | undefined {
  const clientId = nonBlank(env.QUOKY_CALENDAR_GOOGLE_CLIENT_ID);
  const clientSecret = nonBlank(env.QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** See `QuokyConfig.calendar`. No `CHUNSIK_*` alias: these are new keys. */
function resolveCalendar(env: NodeJS.ProcessEnv, timeZone: string): QuokyConfig['calendar'] {
  const client = resolveGoogleCalendarOAuthClient(env);
  const refreshToken = nonBlank(env.QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN);
  const tokenFile = nonBlank(env.QUOKY_CALENDAR_GOOGLE_TOKEN_FILE);
  if (client === undefined || (refreshToken === undefined && tokenFile === undefined)) return undefined;
  const calendarIds = (nonBlank(env.QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS) ?? 'primary')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return {
    google: {
      ...client,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(tokenFile !== undefined ? { tokenFile: resolveDataPath(tokenFile) } : {}),
      calendarIds,
    },
    timeZone,
  };
}

/**
 * Confluence connector config. On Atlassian Cloud a user API token needs Basic `email:apiToken`, so an email is
 * resolved as follows:
 * 1. `QUOKY_CONFLUENCE_EMAIL` when defined. A defined-but-empty value is an explicit "no email" (Bearer, for a
 *    Data Center PAT) and disables the Jira reuse below.
 * 2. Otherwise the Jira email (`QUOKY_JIRA_EMAIL`, legacy alias accepted) when the Confluence and Jira base URLs
 *    name the same host — one Atlassian Cloud site, so the same Atlassian account and API token.
 * 3. Otherwise none → Bearer.
 * The email is a credential component: it is never logged.
 */
function resolveConfluenceConnector(
  env: NodeJS.ProcessEnv,
): { host: string; token: string; email?: string } | undefined {
  const host = nonBlank(env.QUOKY_CONFLUENCE_BASE_URL ?? env.CHUNSIK_CONFLUENCE_BASE_URL);
  const token = nonBlank(env.QUOKY_CONFLUENCE_TOKEN ?? env.CHUNSIK_CONFLUENCE_TOKEN);
  if (!host || !token) return undefined;
  const email = resolveConfluenceEmail(env, host);
  return email ? { host, token, email } : { host, token };
}

function resolveConfluenceEmail(env: NodeJS.ProcessEnv, confluenceHost: string): string | undefined {
  if (env.QUOKY_CONFLUENCE_EMAIL !== undefined) return nonBlank(env.QUOKY_CONFLUENCE_EMAIL);
  const jiraEmail = nonBlank(env.QUOKY_JIRA_EMAIL ?? env.CHUNSIK_JIRA_EMAIL);
  const jiraHost = nonBlank(env.QUOKY_JIRA_BASE_URL ?? env.CHUNSIK_JIRA_BASE_URL);
  if (!jiraEmail || !jiraHost) return undefined;
  const confluenceHostname = hostnameOf(confluenceHost);
  return confluenceHostname !== undefined && confluenceHostname === hostnameOf(jiraHost) ? jiraEmail : undefined;
}

/** Lower-cased hostname of a base URL given with or without a scheme; `undefined` when it does not parse. */
function hostnameOf(value: string): string | undefined {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the GitHub App config (Sprint 4b, ADR-0061). Requires a non-blank `QUOKY_GITHUB_APP_ID` AND a private key
 * from `QUOKY_GITHUB_APP_PRIVATE_KEY` (inline PEM) or `QUOKY_GITHUB_APP_PRIVATE_KEY_PATH` (a file read here).
 * Returns `undefined` on any missing/unreadable input — the safe "not configured" path (never throws; a bad key
 * path must not crash unrelated flows). The private key value is never logged.
 */
function resolveGithubApp(env: NodeJS.ProcessEnv): { appId: string; privateKeyPem: string } | undefined {
  const appId = (env.QUOKY_GITHUB_APP_ID ?? '').trim();
  if (appId.length === 0) return undefined;

  let privateKeyPem = env.QUOKY_GITHUB_APP_PRIVATE_KEY;
  if ((privateKeyPem === undefined || privateKeyPem.trim().length === 0) && env.QUOKY_GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      privateKeyPem = readFileSync(env.QUOKY_GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
    } catch {
      privateKeyPem = undefined; // unreadable key file → not configured (fail-safe)
    }
  }
  if (privateKeyPem === undefined || privateKeyPem.trim().length === 0) return undefined;
  return { appId, privateKeyPem };
}

/** Parse a positive-integer installation id, or `undefined` when absent/invalid. */
function parseInstallationId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Explicit `QUOKY_RUNTIME_ENV` wins; otherwise `NODE_ENV=production` → 'prod', else 'dev'. */
function resolveRuntimeEnv(env: NodeJS.ProcessEnv): 'dev' | 'prod' {
  if (env.QUOKY_RUNTIME_ENV === 'dev') return 'dev';
  if (env.QUOKY_RUNTIME_ENV === 'prod') return 'prod';
  return env.NODE_ENV === 'production' ? 'prod' : 'dev';
}

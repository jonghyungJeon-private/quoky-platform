import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CLAUDE_MODEL } from '@quoky/ai-cli';
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
  discord: { token: string; guildId?: string; ownerIds: string[]; channelIds: string[] };
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
  /** Personal-edition git safety (ADR-0094). `remoteEnabled` defaults to false (push/sync refused). */
  git: { remoteEnabled: boolean; mergeEnabled: boolean };
  /**
   * Personal v2 inert configuration (ADR-0096 D9, parsed once in wave 1; no consumer yet). Parsing a variable
   * authorizes no behaviour; semantics belong to the track ADRs.
   * `work.summaryEnabled` (`QUOKY_WORK_SUMMARY_ENABLED`, default true; ADR-0100).
   */
  work: { summaryEnabled: boolean };
  /** `QUOKY_REMINDERS_ENABLED`, `QUOKY_REMINDERS_CHANNEL_DELIVERY`, `QUOKY_TIMEZONE` (ADR-0101; default off). */
  reminders: ReminderConfig;
  /**
   * Opt-in local embedding recall (ADR-0098 D8). `model` is a bounded token and never a cloud-served model.
   * `timeoutMs` bounds one embedding call; `maxNewPerTurn` is fixed at 4.
   */
  embedding: { enabled: boolean; model: string; timeoutMs: number; maxNewPerTurn: number };
  connectors: {
    jira?: { host: string; email: string; apiToken: string };
    slack?: { token: string };
    confluence?: { host: string; token: string };
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
  ...ReminderConfigErrorCode,
  CONTEXT_MAX_TOKENS_INVALID: 'CONTEXT_MAX_TOKENS_INVALID',
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

  return {
    discord: {
      token: env.DISCORD_BOT_TOKEN ?? '',
      guildId: env.DISCORD_GUILD_ID,
      ownerIds,
      channelIds: parseDiscordIdList(env.QUOKY_DISCORD_CHANNEL_IDS, QuokyConfigErrorCode.DISCORD_CHANNEL_IDS_INVALID),
    },
    storage: { dbPath: resolveDataPath(env.QUOKY_DB_PATH ?? env.CHUNSIK_DB_PATH ?? './data/chunsik.db') },
    vector: { storePath: resolveDataPath(env.QUOKY_VECTOR_PATH ?? env.CHUNSIK_VECTOR_PATH ?? './data/vectors') },
    workspace: { workspaceRoot: env.QUOKY_WORKSPACE_ROOT ?? env.CHUNSIK_WORKSPACE_ROOT ?? process.cwd() },
    ai: {
      claudeBin: env.CLAUDE_CLI_BIN ?? 'claude',
      claudeModel: parseClaudeModel(env.QUOKY_CLAUDE_MODEL),
      codexBin: env.CODEX_CLI_BIN ?? 'codex',
      ollamaBin: env.OLLAMA_CLI_BIN ?? 'ollama',
      ollamaModel: env.OLLAMA_MODEL ?? 'llama3.1',
      // Registration flag only (ADR-0092): opt-out, exact true/false, never inferred from OLLAMA_MODEL.
      ollamaEnabled: parseExactBoolean(env.QUOKY_OLLAMA_ENABLED, true, QuokyConfigErrorCode.OLLAMA_ENABLED_INVALID),
    },
    git: { remoteEnabled: gitRemoteEnabled, mergeEnabled: gitMergeEnabled },
    work: {
      summaryEnabled: parseExactBoolean(
        env.QUOKY_WORK_SUMMARY_ENABLED,
        true,
        QuokyConfigErrorCode.WORK_SUMMARY_ENABLED_INVALID,
      ),
    },
    reminders: parseReminderConfig(env),
    embedding: {
      enabled: parseExactBoolean(env.QUOKY_EMBEDDING_ENABLED, false, QuokyConfigErrorCode.EMBEDDING_ENABLED_INVALID),
      model: parseEmbeddingModel(env.QUOKY_EMBEDDING_MODEL),
      timeoutMs: parseEmbeddingTimeoutMs(env.QUOKY_EMBEDDING_TIMEOUT_MS),
      maxNewPerTurn: EMBEDDING_MAX_NEW_PER_TURN,
    },
    connectors: {
      jira: resolveJiraConnector(env),
      slack: resolveSlackConnector(env),
      confluence: resolveConfluenceConnector(env),
    },
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

function resolveConfluenceConnector(env: NodeJS.ProcessEnv): { host: string; token: string } | undefined {
  const host = nonBlank(env.QUOKY_CONFLUENCE_BASE_URL ?? env.CHUNSIK_CONFLUENCE_BASE_URL);
  const token = nonBlank(env.QUOKY_CONFLUENCE_TOKEN ?? env.CHUNSIK_CONFLUENCE_TOKEN);
  return host && token ? { host, token } : undefined;
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

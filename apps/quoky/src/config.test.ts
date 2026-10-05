import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig as loadConfigFromEnv, QuokyConfigError } from './config';

const OWNER = '111111111111111111';
const OWNER_2 = '222222222222222222';
const CHANNEL = '444444444444444444';
const CHANNEL_2 = '555555555555555555';

/**
 * Personal edition requires owner ids (ADR-0091), so every unrelated fixture gets a valid one unless it sets
 * the variable itself. Tests of the owner-id parsing itself use `loadConfigFromEnv` directly.
 */
function loadConfig(raw: NodeJS.ProcessEnv): ReturnType<typeof loadConfigFromEnv> {
  return loadConfigFromEnv({ QUOKY_DISCORD_OWNER_IDS: OWNER, ...raw });
}

/** Build a minimal env with only the given keys set (Sprint 3d-A, ADR-0051, CA change 8). */
function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('loadConfig — ContextBuilder GENERAL_CHAT defaults', () => {
  it('activates ranking, relevance, token budgeting, and compression explicitly', () => {
    expect(loadConfig(env({})).contextBuilder).toEqual({
      rankingEnabled: true,
      compressionEnabled: true,
      maxTokens: 6000,
      recencyWeight: 0.4,
      relevanceWeight: 0.6,
      compressionConfig: { minimumCharactersPerEntry: 80 },
    });
  });
});

describe('loadConfig — repositoryHosting (Sprint 3d-A, ADR-0051, CA change 8)', () => {
  it('reads CHUNSIK_GITHUB_OWNER / CHUNSIK_GITHUB_REPO into repositoryHosting; provider fixed github (test 42)', () => {
    const cfg = loadConfig(env({ CHUNSIK_GITHUB_OWNER: 'acme', CHUNSIK_GITHUB_REPO: 'widgets' }));
    expect(cfg.repositoryHosting).toEqual({ provider: 'github', owner: 'acme', repo: 'widgets' });
  });

  it('leaves repositoryHosting undefined when both owner and repo are absent (test 45)', () => {
    expect(loadConfig(env({})).repositoryHosting).toBeUndefined();
  });

  it('does not read CHUNSIK_GITHUB_PROVIDER — provider is always github (test 44)', () => {
    const cfg = loadConfig(
      env({ CHUNSIK_GITHUB_OWNER: 'acme', CHUNSIK_GITHUB_REPO: 'widgets', CHUNSIK_GITHUB_PROVIDER: 'gitlab' }),
    );
    expect(cfg.repositoryHosting?.provider).toBe('github');
  });

  it('reads no token env var into repositoryHosting — only provider/owner/repo keys (tests 43/52/54)', () => {
    const cfg = loadConfig(
      env({
        CHUNSIK_GITHUB_OWNER: 'acme',
        CHUNSIK_GITHUB_REPO: 'widgets',
        CHUNSIK_GITHUB_TOKEN: 'ghp_shouldNotAppear',
        GITHUB_TOKEN: 'ghp_alsoNot',
      }),
    );
    expect(Object.keys(cfg.repositoryHosting ?? {}).sort()).toEqual(['owner', 'provider', 'repo']);
    expect(JSON.stringify(cfg.repositoryHosting)).not.toContain('ghp_');
    expect(JSON.stringify(cfg.repositoryHosting ?? {})).not.toMatch(/token/i);
  });

  it('creates raw config when only one of owner/repo is present (resolver later classifies validity)', () => {
    expect(loadConfig(env({ CHUNSIK_GITHUB_OWNER: 'acme' })).repositoryHosting).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: '',
    });
    expect(loadConfig(env({ CHUNSIK_GITHUB_REPO: 'widgets' })).repositoryHosting).toEqual({
      provider: 'github',
      owner: '',
      repo: 'widgets',
    });
  });
});

describe('loadConfig — githubToken (Sprint 3d-D, ADR-0054, CA change 3/6)', () => {
  it('reads CHUNSIK_GITHUB_TOKEN into githubToken (adapter-local, never into repositoryHosting)', () => {
    const cfg = loadConfig(env({ CHUNSIK_GITHUB_OWNER: 'acme', CHUNSIK_GITHUB_REPO: 'widgets', CHUNSIK_GITHUB_TOKEN: 'ghp_secret' }));
    expect(cfg.githubToken).toBe('ghp_secret');
    // the token never leaks into the identity config
    expect(JSON.stringify(cfg.repositoryHosting)).not.toContain('ghp_secret');
    expect(Object.keys(cfg.repositoryHosting ?? {}).sort()).toEqual(['owner', 'provider', 'repo']);
  });
  it('leaves githubToken undefined when unset', () => {
    expect(loadConfig(env({ CHUNSIK_GITHUB_OWNER: 'acme', CHUNSIK_GITHUB_REPO: 'widgets' })).githubToken).toBeUndefined();
  });
});

describe('loadConfig — GitHub App auth (Sprint 4b, ADR-0061)', () => {
  it('prefers QUOKY_GITHUB_OWNER/REPO and falls back to legacy CHUNSIK_GITHUB_OWNER/REPO', () => {
    expect(loadConfig(env({ QUOKY_GITHUB_OWNER: 'q', QUOKY_GITHUB_REPO: 'r' })).repositoryHosting).toEqual({
      provider: 'github',
      owner: 'q',
      repo: 'r',
    });
    expect(loadConfig(env({ CHUNSIK_GITHUB_OWNER: 'c', CHUNSIK_GITHUB_REPO: 'd' })).repositoryHosting).toEqual({
      provider: 'github',
      owner: 'c',
      repo: 'd',
    });
    // QUOKY_* wins when both are set.
    expect(
      loadConfig(
        env({ QUOKY_GITHUB_OWNER: 'q', QUOKY_GITHUB_REPO: 'r', CHUNSIK_GITHUB_OWNER: 'c', CHUNSIK_GITHUB_REPO: 'd' }),
      ).repositoryHosting,
    ).toEqual({ provider: 'github', owner: 'q', repo: 'r' });
  });

  it('reads QUOKY_GITHUB_APP_ID + QUOKY_GITHUB_APP_PRIVATE_KEY into githubApp; the key never leaks to repositoryHosting', () => {
    const cfg = loadConfig(
      env({
        QUOKY_GITHUB_OWNER: 'q',
        QUOKY_GITHUB_REPO: 'r',
        QUOKY_GITHUB_APP_ID: '123',
        QUOKY_GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----',
      }),
    );
    expect(cfg.githubApp).toEqual({
      appId: '123',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----',
    });
    expect(JSON.stringify(cfg.repositoryHosting)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('leaves githubApp undefined when appId or the private key is missing', () => {
    expect(loadConfig(env({ QUOKY_GITHUB_APP_ID: '123' })).githubApp).toBeUndefined();
    expect(loadConfig(env({ QUOKY_GITHUB_APP_PRIVATE_KEY: 'x' })).githubApp).toBeUndefined();
  });

  it('parses QUOKY_GITHUB_APP_INSTALLATION_ID as a positive integer (else undefined)', () => {
    expect(loadConfig(env({ QUOKY_GITHUB_APP_INSTALLATION_ID: '4242' })).githubAppInstallationId).toBe(4242);
    expect(loadConfig(env({ QUOKY_GITHUB_APP_INSTALLATION_ID: 'nope' })).githubAppInstallationId).toBeUndefined();
  });

  it('derives runtimeEnv: explicit QUOKY_RUNTIME_ENV wins, else NODE_ENV=production → prod, else dev', () => {
    expect(loadConfig(env({ QUOKY_RUNTIME_ENV: 'prod' })).runtimeEnv).toBe('prod');
    expect(loadConfig(env({ QUOKY_RUNTIME_ENV: 'dev', NODE_ENV: 'production' })).runtimeEnv).toBe('dev');
    expect(loadConfig(env({ NODE_ENV: 'production' })).runtimeEnv).toBe('prod');
    expect(loadConfig(env({})).runtimeEnv).toBe('dev');
  });

  it('keeps CHUNSIK_GITHUB_TOKEN as the dev-only PAT (unchanged env)', () => {
    expect(loadConfig(env({ CHUNSIK_GITHUB_TOKEN: 'ghp_x' })).githubToken).toBe('ghp_x');
  });
});

describe('loadConfig — dormant Provider routing activation (Stage 2B Slice 5C-I)', () => {
  it('maps missing and exact legacy to legacy', () => {
    expect(loadConfig(env({})).providerRoutingMode).toBe('legacy');
    expect(loadConfig(env({ QUOKY_PROVIDER_ROUTING_MODE: 'legacy' })).providerRoutingMode).toBe('legacy');
  });

  it('accepts only the exact enabled candidate', () => {
    expect(loadConfig(env({ QUOKY_PROVIDER_ROUTING_MODE: 'stage2b-general-chat-v1' })).providerRoutingMode).toBe(
      'stage2b-general-chat-v1',
    );
  });

  it.each(['', ' ', ' legacy ', 'LEGACY', 'Stage2b-general-chat-v1', 'true', '1', 'yes', 'enabled', 'on'])(
    'rejects invalid exact value %j',
    (value) => {
      expect(() => loadConfig(env({ QUOKY_PROVIDER_ROUTING_MODE: value }))).toThrow(
        'PROVIDER_ROUTING_INVALID_MODE',
      );
    },
  );

  it('uses identical parsing in dev and prod', () => {
    for (const runtime of ['dev', 'prod']) {
      expect(
        loadConfig(env({ QUOKY_RUNTIME_ENV: runtime, QUOKY_PROVIDER_ROUTING_MODE: 'legacy' }))
          .providerRoutingMode,
      ).toBe('legacy');
      expect(() =>
        loadConfig(env({ QUOKY_RUNTIME_ENV: runtime, QUOKY_PROVIDER_ROUTING_MODE: 'LEGACY' })),
      ).toThrow('PROVIDER_ROUTING_INVALID_MODE');
    }
  });

  it('does not read a CHUNSIK_PROVIDER_ROUTING_MODE alias', () => {
    expect(loadConfig(env({ CHUNSIK_PROVIDER_ROUTING_MODE: 'stage2b-general-chat-v1' })).providerRoutingMode).toBe(
      'legacy',
    );
  });
});

describe('loadConfig — continuation receiver activation mode (R2, §31)', () => {
  it('maps missing and exact disabled to disabled', () => {
    expect(loadConfig(env({})).continuationReceiverMode).toBe('disabled');
    expect(loadConfig(env({ QUOKY_CONTINUATION_RECEIVER_MODE: 'disabled' })).continuationReceiverMode).toBe(
      'disabled',
    );
  });

  it('rejects the exact general-chat-v1 candidate until R3 containment', () => {
    expect(() => loadConfig(env({ QUOKY_CONTINUATION_RECEIVER_MODE: 'general-chat-v1' })))
      .toThrow('CONTINUATION_RECEIVER_CONTAINMENT_UNAVAILABLE');
  });

  it.each(['', ' ', ' disabled ', 'DISABLED', 'General-Chat-v1', 'true', '1', 'yes', 'enabled', 'on'])(
    'rejects invalid exact value %j',
    (value) => {
      expect(() => loadConfig(env({ QUOKY_CONTINUATION_RECEIVER_MODE: value }))).toThrow(
        'CONTINUATION_RECEIVER_INVALID_MODE',
      );
    },
  );

  it('uses identical parsing in dev and prod', () => {
    for (const runtime of ['dev', 'prod']) {
      expect(
        loadConfig(env({ QUOKY_RUNTIME_ENV: runtime, QUOKY_CONTINUATION_RECEIVER_MODE: 'disabled' }))
          .continuationReceiverMode,
      ).toBe('disabled');
      expect(() =>
        loadConfig(env({ QUOKY_RUNTIME_ENV: runtime, QUOKY_CONTINUATION_RECEIVER_MODE: 'DISABLED' })),
      ).toThrow('CONTINUATION_RECEIVER_INVALID_MODE');
    }
  });

  it('is independent of the provider routing mode (not coupled)', () => {
    const config = loadConfig(
      env({ QUOKY_PROVIDER_ROUTING_MODE: 'stage2b-general-chat-v1', QUOKY_CONTINUATION_RECEIVER_MODE: 'disabled' }),
    );
    expect(config.providerRoutingMode).toBe('stage2b-general-chat-v1');
    expect(config.continuationReceiverMode).toBe('disabled');
  });

  it('does not read a CHUNSIK_CONTINUATION_RECEIVER_MODE alias', () => {
    expect(
      loadConfig(env({ CHUNSIK_CONTINUATION_RECEIVER_MODE: 'general-chat-v1' })).continuationReceiverMode,
    ).toBe('disabled');
  });
});

describe('loadConfig — Actor identity mappings (M3A-1.1)', () => {
  it('parses one or more explicit non-secret Discord-to-work identity mappings', () => {
    const actorIdentityMappings = [
      { actor: { platform: 'discord', externalId: ' discord-1 ' }, identities: { jira: ' account-123 ', github: 'octocat' } },
      { actor: { platform: 'discord', externalId: 'discord-2' }, identities: { github: 'hub-user' } },
    ];
    expect(loadConfig(env({ QUOKY_ACTOR_IDENTITY_MAPPINGS: JSON.stringify(actorIdentityMappings) })).actorIdentityMappings)
      .toEqual([
        { actor: { platform: 'discord', externalId: 'discord-1' }, identities: { jira: 'account-123', github: 'octocat' } },
        { actor: { platform: 'discord', externalId: 'discord-2' }, identities: { github: 'hub-user' } },
      ]);
  });

  it('defaults to no mappings when the variable is absent or blank', () => {
    expect(loadConfig(env({})).actorIdentityMappings).toEqual([]);
    expect(loadConfig(env({ QUOKY_ACTOR_IDENTITY_MAPPINGS: '  ' })).actorIdentityMappings).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{'],
    ['non-array root', '{}'],
    ['blank locator', JSON.stringify([{ actor: { platform: 'discord', externalId: ' ' }, identities: { jira: 'x' } }])],
    ['wrong locator platform', JSON.stringify([{ actor: { platform: 'slack', externalId: 'x' }, identities: { jira: 'x' } }])],
    ['blank Jira identity', JSON.stringify([{ actor: { platform: 'discord', externalId: 'x' }, identities: { jira: ' ' } }])],
    ['invalid GitHub login', JSON.stringify([{ actor: { platform: 'discord', externalId: 'x' }, identities: { github: 'not a login' } }])],
    ['credential-shaped unknown field', JSON.stringify([{ actor: { platform: 'discord', externalId: 'x' }, identities: { jira: 'x', token: 'secret' } }])],
    ['empty identities', JSON.stringify([{ actor: { platform: 'discord', externalId: 'x' }, identities: {} }])],
    ['different same-platform mappings', JSON.stringify([
      { actor: { platform: 'discord', externalId: 'x' }, identities: { jira: 'one' } },
      { actor: { platform: 'discord', externalId: 'x' }, identities: { jira: 'two' } },
    ])],
    ['same target assigned to different locators', JSON.stringify([
      { actor: { platform: 'discord', externalId: 'x' }, identities: { jira: 'one' } },
      { actor: { platform: 'discord', externalId: 'y' }, identities: { jira: 'one' } },
    ])],
  ])('fails closed for %s', (_case, value) => {
    expect(() => loadConfig(env({ QUOKY_ACTOR_IDENTITY_MAPPINGS: value }))).toThrow(/ACTOR_IDENTITY_MAPPING/);
  });
});

describe('loadConfig — static AgentProfile configuration (M3E-6H, ADR-0089)', () => {
  const profile = {
    id: 'receiver', displayName: 'Receiver', role: 'implementer',
    purpose: 'continue delegated work', instructions: 'Follow the handoff objective.',
  };

  it('defaults to no profiles when the variable is absent or blank, keeping continuation fail-closed', () => {
    expect(loadConfig(env({})).agentProfiles).toEqual([]);
    expect(loadConfig(env({ QUOKY_AGENT_PROFILES: '   ' })).agentProfiles).toEqual([]);
  });

  it('accepts an explicit empty array without activating anything', () => {
    expect(loadConfig(env({ QUOKY_AGENT_PROFILES: '[]' })).agentProfiles).toEqual([]);
  });

  it('parses one profile using exactly the five existing domain fields', () => {
    expect(loadConfig(env({ QUOKY_AGENT_PROFILES: JSON.stringify([profile]) })).agentProfiles).toEqual([profile]);
  });

  it('parses multiple profiles deterministically and preserves exact ids', () => {
    const second = { ...profile, id: 'source', displayName: 'Source' };
    const parsed = loadConfig(env({ QUOKY_AGENT_PROFILES: JSON.stringify([second, profile]) })).agentProfiles;
    expect(parsed.map((entry) => entry.id)).toEqual(['receiver', 'source']);
    expect(parsed).toEqual([profile, second]);
  });

  it('freezes each parsed profile so no caller can mutate configuration', () => {
    const [parsed] = loadConfig(env({ QUOKY_AGENT_PROFILES: JSON.stringify([profile]) })).agentProfiles;
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ['invalid JSON', '{'],
    ['non-array root', '{}'],
    ['entry wrong type', JSON.stringify(['receiver'])],
    ['null entry', JSON.stringify([null])],
    ['missing required field', JSON.stringify([{ ...profile, instructions: undefined }])],
    ['wrong field type', JSON.stringify([{ ...profile, role: 7 }])],
    ['blank required field', JSON.stringify([{ ...profile, purpose: '   ' }])],
    ['invalid id shape', JSON.stringify([{ ...profile, id: 'not a valid id' }])],
    ['duplicate id', JSON.stringify([profile, { ...profile, displayName: 'Other' }])],
    ['provider pin unknown field', JSON.stringify([{ ...profile, providerId: 'claude' }])],
    ['credential-shaped unknown field', JSON.stringify([{ ...profile, apiKey: 'shhh' }])],
    ['tool allowlist unknown field', JSON.stringify([{ ...profile, tools: ['shell'] }])],
    ['capability grant unknown field', JSON.stringify([{ ...profile, capabilities: ['CODE_GENERATION'] }])],
    ['approval grant unknown field', JSON.stringify([{ ...profile, approved: true }])],
    ['executable path unknown field', JSON.stringify([{ ...profile, executablePath: '/bin/sh' }])],
    ['oversized instructions', JSON.stringify([{ ...profile, instructions: 'x'.repeat(16_385) }])],
    ['too many entries', JSON.stringify(Array.from({ length: 65 }, (_unused, index) => ({ ...profile, id: `p${index}` })))],
  ])('fails closed for %s', (_case, value) => {
    expect(() => loadConfig(env({ QUOKY_AGENT_PROFILES: value }))).toThrow(/AGENT_PROFILE/);
  });

  it('fails closed on an oversized payload without parsing it', () => {
    expect(() => loadConfig(env({ QUOKY_AGENT_PROFILES: `"${'x'.repeat(1_048_576)}"` })))
      .toThrow('AGENT_PROFILES_PAYLOAD_TOO_LARGE');
  });

  it('never echoes raw instructions, secret-like content or the payload in configuration errors', () => {
    const leaky = JSON.stringify([{
      ...profile, instructions: 'SENTINEL-INSTRUCTIONS-DO-NOT-ECHO', apiKey: 'SENTINEL-SECRET-VALUE',
    }]);
    try {
      loadConfig(env({ QUOKY_AGENT_PROFILES: leaky }));
      throw new Error('expected configuration to fail closed');
    } catch (error) {
      const text = `${(error as Error).message}${(error as Error).stack ?? ''}`;
      expect(text).toContain('AGENT_PROFILE_0_UNKNOWN_FIELD');
      expect(text).not.toContain('SENTINEL-INSTRUCTIONS-DO-NOT-ECHO');
      expect(text).not.toContain('SENTINEL-SECRET-VALUE');
      expect(text).not.toContain(leaky);
    }
  });

  it('reports the failing configuration key with a bounded index and reason', () => {
    const value = JSON.stringify([profile, { ...profile, id: 'second', role: 5 }]);
    expect(() => loadConfig(env({ QUOKY_AGENT_PROFILES: value }))).toThrow('AGENT_PROFILE_1_ROLE_INVALID');
  });
});

const repoRoot = path.resolve(__dirname, '../../..');

describe('Confluence connector email (Atlassian Cloud Basic auth)', () => {
  const base = {
    QUOKY_CONFLUENCE_BASE_URL: 'https://site.atlassian.net/wiki',
    QUOKY_CONFLUENCE_TOKEN: 'fixture-atlassian-token',
  };
  const jira = {
    QUOKY_JIRA_BASE_URL: 'https://site.atlassian.net',
    QUOKY_JIRA_EMAIL: 'jira@example.test',
    QUOKY_JIRA_TOKEN: 'fixture-atlassian-token',
  };

  it('uses QUOKY_CONFLUENCE_EMAIL when set', () => {
    expect(loadConfig(env({ ...base, ...jira, QUOKY_CONFLUENCE_EMAIL: ' wiki@example.test ' })).connectors.confluence)
      .toEqual({ host: base.QUOKY_CONFLUENCE_BASE_URL, token: base.QUOKY_CONFLUENCE_TOKEN, email: 'wiki@example.test' });
  });

  it('reuses the Jira email when the Confluence and Jira base URLs share a host', () => {
    expect(loadConfig(env({ ...base, ...jira })).connectors.confluence).toEqual({
      host: base.QUOKY_CONFLUENCE_BASE_URL, token: base.QUOKY_CONFLUENCE_TOKEN, email: 'jira@example.test',
    });
    // Scheme-less and differently cased hosts still compare equal.
    expect(loadConfig(env({ ...base, ...jira, QUOKY_JIRA_BASE_URL: 'SITE.atlassian.net' })).connectors.confluence?.email)
      .toBe('jira@example.test');
    // Legacy Jira aliases are honoured the same way.
    expect(loadConfig(env({ ...base, CHUNSIK_JIRA_BASE_URL: jira.QUOKY_JIRA_BASE_URL, CHUNSIK_JIRA_EMAIL: 'legacy@example.test' }))
      .connectors.confluence?.email).toBe('legacy@example.test');
  });

  it('does not reuse the Jira email for a different host (Bearer stays)', () => {
    expect(loadConfig(env({ ...base, ...jira, QUOKY_JIRA_BASE_URL: 'https://other.atlassian.net' })).connectors.confluence)
      .toEqual({ host: base.QUOKY_CONFLUENCE_BASE_URL, token: base.QUOKY_CONFLUENCE_TOKEN });
    expect(loadConfig(env({ ...base, QUOKY_JIRA_EMAIL: 'jira@example.test' })).connectors.confluence)
      .toEqual({ host: base.QUOKY_CONFLUENCE_BASE_URL, token: base.QUOKY_CONFLUENCE_TOKEN });
  });

  it('treats an explicitly empty QUOKY_CONFLUENCE_EMAIL as Bearer and skips the Jira reuse', () => {
    expect(loadConfig(env({ ...base, ...jira, QUOKY_CONFLUENCE_EMAIL: '' })).connectors.confluence)
      .toEqual({ host: base.QUOKY_CONFLUENCE_BASE_URL, token: base.QUOKY_CONFLUENCE_TOKEN });
  });
});

describe('Product namespace environment compatibility', () => {
  const values = {
    DB_PATH: '/fixture/data.db', VECTOR_PATH: '/fixture/vectors', WORKSPACE_ROOT: '/fixture/work',
    GITHUB_OWNER: 'canonical-owner', GITHUB_REPO: 'canonical-repo', GITHUB_TOKEN: 'fixture-pat',
    JIRA_BASE_URL: 'https://jira.example.test', JIRA_EMAIL: 'fixture@example.test', JIRA_TOKEN: 'fixture-jira',
    SLACK_TOKEN: 'fixture-slack', CONFLUENCE_BASE_URL: 'https://confluence.example.test',
    CONFLUENCE_TOKEN: 'fixture-confluence',
  };
  const expected = {
    storage: { dbPath: values.DB_PATH }, vector: { storePath: values.VECTOR_PATH },
    workspace: { workspaceRoot: values.WORKSPACE_ROOT },
    repositoryHosting: { provider: 'github', owner: values.GITHUB_OWNER, repo: values.GITHUB_REPO },
    githubToken: values.GITHUB_TOKEN,
    connectors: {
      jira: { host: values.JIRA_BASE_URL, email: values.JIRA_EMAIL, apiToken: values.JIRA_TOKEN },
      slack: { token: values.SLACK_TOKEN },
      confluence: { host: values.CONFLUENCE_BASE_URL, token: values.CONFLUENCE_TOKEN },
    },
  };
  const named = (prefix: string, entries: Record<string, string>) =>
    Object.fromEntries(Object.entries(entries).map(([key, value]) => [`${prefix}_${key}`, value]));

  it.each(['QUOKY', 'CHUNSIK'])('accepts %s-only configuration for every migrated setting', (prefix) => {
    expect(loadConfig(named(prefix, values))).toMatchObject(expected);
  });

  it('prefers every canonical value when both namespaces are defined', () => {
    const legacy = Object.fromEntries(Object.keys(values).map(key => [key, 'legacy-value']));
    expect(loadConfig({ ...named('CHUNSIK', legacy), ...named('QUOKY', values) })).toMatchObject(expected);
  });

  it('preserves defaults when both namespaces are absent', () => {
    expect(loadConfig({})).toMatchObject({
      storage: { dbPath: path.resolve(repoRoot, 'data/chunsik.db') },
      vector: { storePath: path.resolve(repoRoot, 'data/vectors') },
      workspace: { workspaceRoot: process.cwd() },
      githubToken: undefined, repositoryHosting: undefined,
      connectors: { jira: undefined, slack: undefined, confluence: undefined },
    });
  });

  it('does not resurrect legacy values when canonical settings are explicitly empty', () => {
    const empty = Object.fromEntries(Object.keys(values).map(key => [key, '']));
    expect(loadConfig({ ...named('CHUNSIK', values), ...named('QUOKY', empty) })).toMatchObject({
      storage: { dbPath: '' }, vector: { storePath: '' }, workspace: { workspaceRoot: '' },
      githubToken: '', repositoryHosting: undefined,
      connectors: { jira: undefined, slack: undefined, confluence: undefined },
    });
  });

  it('keeps existing App settings and runtime mode alongside the canonical dev PAT', () => {
    expect(loadConfig({ ...named('QUOKY', values), QUOKY_RUNTIME_ENV: 'prod',
      QUOKY_GITHUB_APP_ID: '123', QUOKY_GITHUB_APP_PRIVATE_KEY: 'synthetic-fixture-key',
      QUOKY_GITHUB_APP_INSTALLATION_ID: '456',
    })).toMatchObject({ githubToken: values.GITHUB_TOKEN, runtimeEnv: 'prod',
      githubApp: { appId: '123', privateKeyPem: 'synthetic-fixture-key' }, githubAppInstallationId: 456 });
    // Authentication selection/rejection remains at the existing composition boundary.
  });
});

describe('production continuation mode startup guard (R2)', () => {
  it('boots disabled with the mode unset', () => {
    expect(loadConfig({}).continuationReceiverMode).toBe('disabled');
  });
  it.each([undefined, 'disabled', 'general-chat-v1'])(
    'rejects enabled continuation independently of provider routing mode %s', (providerMode) => {
      expect(() => loadConfig({
        QUOKY_CONTINUATION_RECEIVER_MODE: 'general-chat-v1',
        QUOKY_PROVIDER_ROUTING_MODE: providerMode,
      })).toThrowError(expect.objectContaining({
        name: 'ContinuationReceiverActivationError',
        code: 'CONTINUATION_RECEIVER_CONTAINMENT_UNAVAILABLE',
        message: 'CONTINUATION_RECEIVER_CONTAINMENT_UNAVAILABLE',
      }));
    },
  );
});

describe('loadConfig — Discord owner ids (ADR-0091)', () => {
  it('parses one or several comma-separated owner snowflakes, trimming and de-duplicating', () => {
    expect(loadConfigFromEnv({ QUOKY_DISCORD_OWNER_IDS: OWNER }).discord.ownerIds).toEqual([OWNER]);
    expect(loadConfigFromEnv({ QUOKY_DISCORD_OWNER_IDS: ` ${OWNER} , ${OWNER_2},${OWNER}` }).discord.ownerIds)
      .toEqual([OWNER, OWNER_2]);
  });

  it.each([undefined, '', '   '])('fails closed when owner ids are missing or blank (%j)', (value) => {
    const source: NodeJS.ProcessEnv = value === undefined ? {} : { QUOKY_DISCORD_OWNER_IDS: value };
    expect(() => loadConfigFromEnv(source)).toThrow('DISCORD_OWNER_IDS_MISSING');
    expect(() => loadConfigFromEnv(source)).toThrow(QuokyConfigError);
  });

  it.each(['abc', '123', `${OWNER},`, `,${OWNER}`, `${OWNER},,${OWNER_2}`, `${OWNER};${OWNER_2}`, '1'.repeat(21), '<@111111111111111111>'])(
    'rejects malformed owner list %j without echoing it',
    (value) => {
      let caught: unknown;
      try { loadConfigFromEnv({ QUOKY_DISCORD_OWNER_IDS: value }); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(QuokyConfigError);
      expect((caught as QuokyConfigError).code).toBe('DISCORD_OWNER_IDS_INVALID');
      expect((caught as Error).message).toBe('DISCORD_OWNER_IDS_INVALID');
    },
  );

  it('rejects an oversized owner list', () => {
    const many = Array.from({ length: 65 }, (_, i) => String(100000000000000000 + i)).join(',');
    expect(() => loadConfigFromEnv({ QUOKY_DISCORD_OWNER_IDS: many })).toThrow('DISCORD_OWNER_IDS_INVALID');
  });
});

describe('loadConfig — Discord channel ids (ADR-0091)', () => {
  it('defaults to an empty list (owner DMs only) when unset or blank', () => {
    expect(loadConfig(env({})).discord.channelIds).toEqual([]);
    expect(loadConfig(env({ QUOKY_DISCORD_CHANNEL_IDS: '' })).discord.channelIds).toEqual([]);
    expect(loadConfig(env({ QUOKY_DISCORD_CHANNEL_IDS: '  ' })).discord.channelIds).toEqual([]);
  });

  it('parses comma-separated channel snowflakes', () => {
    expect(loadConfig(env({ QUOKY_DISCORD_CHANNEL_IDS: `${CHANNEL}, ${CHANNEL_2}` })).discord.channelIds)
      .toEqual([CHANNEL, CHANNEL_2]);
  });

  it.each(['general', `${CHANNEL},`, `${CHANNEL},,${CHANNEL_2}`, '#general'])('rejects malformed channel list %j', (value) => {
    expect(() => loadConfig(env({ QUOKY_DISCORD_CHANNEL_IDS: value }))).toThrow('DISCORD_CHANNEL_IDS_INVALID');
  });
});

describe('loadConfig — Ollama registration flag (ADR-0092)', () => {
  it('defaults to enabled (opt-out) and accepts exact true/false', () => {
    expect(loadConfig(env({})).ai.ollamaEnabled).toBe(true);
    expect(loadConfig(env({ QUOKY_OLLAMA_ENABLED: 'true' })).ai.ollamaEnabled).toBe(true);
    expect(loadConfig(env({ QUOKY_OLLAMA_ENABLED: 'false' })).ai.ollamaEnabled).toBe(false);
  });

  it('is never inferred from OLLAMA_MODEL / OLLAMA_CLI_BIN', () => {
    expect(loadConfig(env({ OLLAMA_MODEL: '' })).ai.ollamaEnabled).toBe(true);
    expect(loadConfig(env({ OLLAMA_MODEL: 'llama3.1', OLLAMA_CLI_BIN: '' })).ai.ollamaEnabled).toBe(true);
    expect(loadConfig(env({ QUOKY_OLLAMA_ENABLED: 'false', OLLAMA_MODEL: 'llama3.1' })).ai.ollamaEnabled).toBe(false);
  });

  it.each(['', ' ', 'TRUE', 'False', '1', '0', 'yes', 'on', ' true'])('rejects non-exact value %j', (value) => {
    expect(() => loadConfig(env({ QUOKY_OLLAMA_ENABLED: value }))).toThrow('OLLAMA_ENABLED_INVALID');
  });
});

describe('loadConfig — Claude model (ADR-0092)', () => {
  it('defaults to sonnet', () => {
    expect(loadConfig(env({})).ai.claudeModel).toBe('sonnet');
  });

  it.each(['opus', 'claude-sonnet-4-5', 'claude-opus-4-1-20250805', 'sonnet[1m]', 'anthropic/claude:latest'])(
    'accepts a bounded alias or model token %j',
    (value) => {
      expect(loadConfig(env({ QUOKY_CLAUDE_MODEL: value })).ai.claudeModel).toBe(value);
    },
  );

  it.each(['', ' ', '--dangerously-skip-permissions', '-p', 'two words', 'a;b', 'sonnet\n', 'x'.repeat(129), '$(whoami)'])(
    'rejects an unsafe or unbounded model %j',
    (value) => {
      expect(() => loadConfig(env({ QUOKY_CLAUDE_MODEL: value }))).toThrow('CLAUDE_MODEL_INVALID');
    },
  );
});

describe('loadConfig — git remote flag (ADR-0094)', () => {
  it('defaults to false and accepts exact true/false', () => {
    expect(loadConfig(env({})).git.remoteEnabled).toBe(false);
    expect(loadConfig(env({ QUOKY_GIT_REMOTE_ENABLED: 'true' })).git.remoteEnabled).toBe(true);
    expect(loadConfig(env({ QUOKY_GIT_REMOTE_ENABLED: 'false' })).git.remoteEnabled).toBe(false);
  });

  it('is not inferred from GitHub App or PAT configuration', () => {
    expect(
      loadConfig(env({ QUOKY_GITHUB_APP_ID: '1', QUOKY_GITHUB_APP_PRIVATE_KEY: 'k', QUOKY_GITHUB_TOKEN: 't' })).git.remoteEnabled,
    ).toBe(false);
  });

  it.each(['', 'TRUE', '1', 'yes', ' false'])('rejects non-exact value %j', (value) => {
    expect(() => loadConfig(env({ QUOKY_GIT_REMOTE_ENABLED: value }))).toThrow('GIT_REMOTE_ENABLED_INVALID');
  });
});

describe('loadConfig — context budget', () => {
  it('raises the default GENERAL_CHAT budget to 6000 estimated tokens', () => {
    expect(loadConfig(env({})).contextBuilder.maxTokens).toBe(6000);
  });

  it('accepts a positive integer override and keeps the rest of the policy', () => {
    const cfg = loadConfig(env({ QUOKY_CONTEXT_MAX_TOKENS: '2048' }));
    expect(cfg.contextBuilder.maxTokens).toBe(2048);
    expect(cfg.contextBuilder.compressionConfig).toEqual({ minimumCharactersPerEntry: 80 });
    expect(cfg.contextBuilder.rankingEnabled).toBe(true);
  });

  it.each(['', '0', '-1', '1.5', '1e3', 'abc', ' 100', '200001', '99999999'])('rejects invalid budget %j', (value) => {
    expect(() => loadConfig(env({ QUOKY_CONTEXT_MAX_TOKENS: value }))).toThrow('CONTEXT_MAX_TOKENS_INVALID');
  });
});

describe('loadConfig — data paths resolve against the repository root, not the working directory', () => {
  it('resolves the default relative db and vector paths to absolute repository-root paths', () => {
    const cfg = loadConfig(env({}));
    expect(path.isAbsolute(cfg.storage.dbPath)).toBe(true);
    expect(cfg.storage.dbPath).toBe(path.resolve(repoRoot, 'data/chunsik.db'));
    expect(cfg.vector.storePath).toBe(path.resolve(repoRoot, 'data/vectors'));
  });

  it('does not depend on process.cwd()', () => {
    const before = loadConfig(env({})).storage.dbPath;
    const original = process.cwd();
    try {
      process.chdir(path.sep);
      expect(loadConfig(env({})).storage.dbPath).toBe(before);
    } finally {
      process.chdir(original);
    }
  });

  it('resolves an explicit relative path the same way and leaves absolute and :memory: paths unchanged', () => {
    expect(loadConfig(env({ QUOKY_DB_PATH: './var/q.db' })).storage.dbPath).toBe(path.resolve(repoRoot, 'var/q.db'));
    expect(loadConfig(env({ QUOKY_DB_PATH: '/abs/q.db' })).storage.dbPath).toBe('/abs/q.db');
    expect(loadConfig(env({ QUOKY_DB_PATH: ':memory:' })).storage.dbPath).toBe(':memory:');
  });
});

describe('loadConfig — Personal v2 inert configuration (ADR-0096 D9)', () => {
  it('has safe inert defaults with nothing set', () => {
    const cfg = loadConfig(env({}));
    expect(cfg.git).toEqual({ remoteEnabled: false, mergeEnabled: false });
    expect(cfg.work).toEqual({ summaryEnabled: true });
    expect(cfg.reminders).toEqual({ enabled: false, channelDelivery: false, timeZone: 'Asia/Seoul' });
    expect(cfg.embedding).toEqual({ enabled: false, model: 'nomic-embed-text', timeoutMs: 3000, maxNewPerTurn: 4 });
  });

  it('accepts exact true/false for every new flag', () => {
    const cfg = loadConfig(
      env({
        QUOKY_WORK_SUMMARY_ENABLED: 'false',
        QUOKY_REMINDERS_ENABLED: 'true',
        QUOKY_REMINDERS_CHANNEL_DELIVERY: 'true',
        QUOKY_EMBEDDING_ENABLED: 'true',
        QUOKY_GIT_REMOTE_ENABLED: 'true',
        QUOKY_GIT_MERGE_ENABLED: 'true',
      }),
    );
    expect(cfg.work.summaryEnabled).toBe(false);
    expect(cfg.reminders.enabled).toBe(true);
    expect(cfg.reminders.channelDelivery).toBe(true);
    expect(cfg.embedding.enabled).toBe(true);
    expect(cfg.git.mergeEnabled).toBe(true);
  });

  it.each([
    ['QUOKY_WORK_SUMMARY_ENABLED', 'WORK_SUMMARY_ENABLED_INVALID'],
    ['QUOKY_REMINDERS_ENABLED', 'REMINDERS_ENABLED_INVALID'],
    ['QUOKY_REMINDERS_CHANNEL_DELIVERY', 'REMINDERS_CHANNEL_DELIVERY_INVALID'],
    ['QUOKY_EMBEDDING_ENABLED', 'EMBEDDING_ENABLED_INVALID'],
    ['QUOKY_GIT_MERGE_ENABLED', 'GIT_MERGE_ENABLED_INVALID'],
  ])('%s rejects non-exact booleans with %s and never echoes the value', (variable, code) => {
    for (const value of ['', 'TRUE', '1', 'yes', ' false', 'SECRETVALUE']) {
      let caught: unknown;
      try { loadConfig(env({ [variable]: value })); } catch (err) { caught = err; }
      expect(caught, `${variable}=${JSON.stringify(value)}`).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(code);
      expect((caught as { code?: string }).code).toBe(code);
    }
  });

  it('refuses QUOKY_GIT_MERGE_ENABLED=true while the remote is off or unset', () => {
    expect(() => loadConfig(env({ QUOKY_GIT_MERGE_ENABLED: 'true' }))).toThrow('GIT_MERGE_REQUIRES_REMOTE');
    expect(() => loadConfig(env({ QUOKY_GIT_MERGE_ENABLED: 'true', QUOKY_GIT_REMOTE_ENABLED: 'false' }))).toThrow(
      'GIT_MERGE_REQUIRES_REMOTE',
    );
    expect(loadConfig(env({ QUOKY_GIT_MERGE_ENABLED: 'false', QUOKY_GIT_REMOTE_ENABLED: 'false' })).git.mergeEnabled).toBe(false);
  });

  it('accepts an IANA zone and rejects invalid, offset, blank and oversized zones value-free', () => {
    expect(loadConfig(env({ QUOKY_TIMEZONE: 'America/New_York' })).reminders.timeZone).toBe('America/New_York');
    expect(loadConfig(env({ QUOKY_TIMEZONE: 'UTC' })).reminders.timeZone).toBe('UTC');
    for (const value of ['', 'Mars/Olympus-SECRETVALUE', '+09:00', 'Asia Seoul', 'A'.repeat(65)]) {
      let caught: unknown;
      try { loadConfig(env({ QUOKY_TIMEZONE: value })); } catch (err) { caught = err; }
      expect((caught as Error | undefined)?.message, JSON.stringify(value)).toBe('TIMEZONE_INVALID');
    }
  });

  it('accepts a bounded local embedding model, with an optional tag', () => {
    expect(loadConfig(env({ QUOKY_EMBEDDING_MODEL: 'mxbai-embed-large' })).embedding.model).toBe('mxbai-embed-large');
    expect(loadConfig(env({ QUOKY_EMBEDDING_MODEL: 'nomic-embed-text:v1.5' })).embedding.model).toBe('nomic-embed-text:v1.5');
  });

  it.each(['', ' nomic', '-bad', 'bad name', 'UPPER', 'a:b:c', 'name:', ':tag', 'a/b', 'x'.repeat(65), 'a;rm -rf'])(
    'rejects malformed embedding model %j',
    (value) => {
      expect(() => loadConfig(env({ QUOKY_EMBEDDING_MODEL: value }))).toThrow('EMBEDDING_MODEL_INVALID');
    },
  );

  it.each(['gpt-oss:120b-cloud', 'qwen3-embedding:cloud', 'cloud-embed', 'my-Cloud-model', 'nomic-embed-text:CLOUD'])(
    'refuses cloud embedding model %j with a dedicated error',
    (value) => {
      let caught: unknown;
      try { loadConfig(env({ QUOKY_EMBEDDING_MODEL: value })); } catch (err) { caught = err; }
      expect((caught as Error).message).toBe('EMBEDDING_MODEL_CLOUD_REFUSED');
      expect((caught as Error).message).not.toContain(value);
    },
  );

  it('bounds the embedding timeout', () => {
    expect(loadConfig(env({ QUOKY_EMBEDDING_TIMEOUT_MS: '100' })).embedding.timeoutMs).toBe(100);
    expect(loadConfig(env({ QUOKY_EMBEDDING_TIMEOUT_MS: '30000' })).embedding.timeoutMs).toBe(30000);
    for (const value of ['', '99', '30001', '-1', '1.5', 'abc', '1e3', '9999999']) {
      expect(() => loadConfig(env({ QUOKY_EMBEDDING_TIMEOUT_MS: value })), value).toThrow('EMBEDDING_TIMEOUT_INVALID');
    }
  });
});

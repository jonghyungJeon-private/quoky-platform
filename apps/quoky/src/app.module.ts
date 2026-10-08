import { Module } from '@nestjs/common';
import type { Provider } from '@nestjs/common';

import {
  // Injection tokens (ports)
  PLATFORM_ADAPTER,
  STORAGE_PROVIDER,
  CONTINUATION_BINDING_REPOSITORY,
  QUEUE_PROVIDER,
  VECTOR_PROVIDER,
  WORKSPACE_PROVIDER,
  GIT_PROVIDER,
  WORKSPACE_WRITER,
  COMMAND_RUNNER,
  EXECUTION_PLANNER,
  PROVIDER_SELECTOR,
  AI_PROVIDERS,
  CONNECTOR_PROVIDERS,
  TOOL_PROVIDERS,
  CONVERSATION_TURN_HANDLERS,
  LEARNING_REPOSITORY,
  // Application services (pure core)
  QuokyCore,
  FeedbackRecorder,
  IntentClassifier,
  Planner,
  CapabilityRouter,
  AiProviderManager,
  ActorManager,
  SessionManager,
  ProjectManager,
  ProjectAnalyzer,
  ContextBuilder,
  PromptComposer,
  PromptRenderer,
  TaskManager,
  MemoryManager,
  ArtifactManager,
  WorkspaceManager,
  GitManager,
  DeterministicPlanner,
  PlanningManager,
  ApprovalPolicy,
  ApprovalManager,
  PatchManager,
  WorkspaceWriteManager,
  CommandExecutionManager,
  CommandExecutionReceiptRunner,
  ExecutionReceiptManager,
  CodeGenerationManager,
  ExecutionOrchestrator,
  IntentResolver,
  ConversationRuntime,
  StatelessApprovalFlow,
  StatelessScopeClarificationFlow,
  StatelessApplyPreviewFlow,
  StatelessCredentialOverrideFlow,
  ConnectorManager,
  WorkSurfaceQuery,
  WorkManager,
  WorkHandoffManager,
  AgentProfileRegistry,
  ResponseComposer,
  RiskPolicy,
  RepositoryIdentityResolver,
  RepositoryHostingManager,
} from '@quoky/core';
import type {
  ContinuationBindingRepository,
  ConversationTurnHandler,
  ConnectorWriteFlow,
  AiProvider,
  CommandRunner,
  ConnectorProvider,
  ExecutionPlanner,
  GitProvider,
  LearningRepository,
  PlatformAdapter,
  ProviderSelector,
  StorageProvider,
  VectorProvider,
  WorkspaceProvider,
  WorkspaceWriter,
  ToolProvider,
} from '@quoky/core';

// Concrete providers — the ONLY file allowed to import them.
import { DiscordPlatformAdapter } from '@quoky/adapter-discord';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { LocalQueueProvider } from '@quoky/queue-local';
import { LocalVectorProvider } from '@quoky/vector-local';
import { LocalCloneWorkspaceProvider, LocalWorkspaceWriter } from '@quoky/workspace-local';
import { LocalGitProvider } from '@quoky/git-local';
import { GitHubRepositoryHostingProvider, createPullRequestStatusTokenSource } from '@quoky/repository-hosting-github';
import { GitHubConnectorProvider } from '@quoky/connector-github';
import { GitHubAppAuth, isPermissionNotGrantedError } from '@quoky/github-app-auth';
import { LocalCommandRunner } from '@quoky/command-local';
import { OllamaCliEmbeddingProvider } from '@quoky/ai-cli';

import { loadConfig } from './config';
import { ActorIdentityProvisioner } from './actor-identity-provisioner';
import { createConnectorProviders } from './connector-providers';
import { ConsoleLogger } from './console-logger';
import { createProductionContextBuilder, curatedExampleOptionsOf, learningRemoteDisclosureOf } from './context-builder-provider';
import { logImageUnderstandingSelection, visionModelsOf } from './image-understanding-provider';
import { isCliPresent } from './provider-selection/cli-presence';
import { ProviderCatalog } from './provider-selection/provider-catalog';
import { ProviderSelectionService } from './provider-selection/provider-selection-service';
import {
  ProviderSelectionStore,
  providerSelectionFileIo,
  providerSelectionFilePath,
} from './provider-selection/selection-store';
import { createProviderSelectionProviders } from './features/provider-selection.providers';
import { createProductionConversationRuntime } from './conversation-runtime-provider';
import { GitHubAppGitProvider } from './github-app-git-provider';
import { createGitHubAppTokenSources } from './github-app-token-sources';
import { RepositoryAllowlist } from './repository-allowlist';
import { WorkspaceRepositoryIdentityResolver } from './workspace-repository-resolver';
import { PersonalGitGuard } from './personal-git-guard';
import { PersonalHostingGuard } from './personal-hosting-guard';
import { createProductionRuntimeProviderRoutingActivation } from './provider-routing/provider-routing-activation';
import { toolManagerProvider } from './tool-manager-provider';
import { continuationLifecycleProvider } from './continuation-lifecycle-provider';
import { continuationExecutionEntryProvider, continuationExecutionProvider } from './continuation-execution-provider';
import { createAgentProfileRegistryProvider } from './agent-profile-registry-provider';
import { createProviderDispatchCommit } from './dispatch-commit-provider';
import { codeWorkProviders } from './features/code-work.providers';
import { createFeedbackProviders } from './features/feedback.providers';
import { createCalendarProviders } from './features/calendar.providers';
import { CONNECTOR_WRITE_FLOW, createConnectorWriteComposition } from './features/connector-writes.providers';
import { createMemoryProviders } from './features/memory.providers';
import { remindersProviders, withReminderChannelDelivery } from './features/reminders.providers';
import { turnHandlersProvider } from './features/turn-handlers.providers';
import { workChatProviders } from './features/work-chat.providers';

const config = loadConfig();
const coreLogger = new ConsoleLogger('quoky');
// ADR-0112 / ADR-0110 amendment (CWR-2): the writers whose flags, allowlists and credentials are complete (default:
// none), the v15 receipts view and the runtime's optional write flow. Built once: the calendar handler's help line
// follows whether a calendar writer exists.
const connectorWrites = createConnectorWriteComposition({ config, timeZone: config.reminders.timeZone });
// ADR-0092 amendment + ADR-0111 amendment (runtime switching): the persisted operations-UI default (a private JSON file
// beside the database, no migration) and the registered providers the owner's selection chooses among. Every chat
// provider that can run on this host is registered (Claude always; Codex when its CLI is present or it is selected;
// Ollama chat when OLLAMA_MODEL is set and the CLI is present, or it is selected), plus every configured image option
// (the Codex image option when its CLI is present or it is the configured or persisted image choice).
// Which one answers is the router's ProviderSelectionPolicy (ProviderSelectionService); construction spawns nothing.
const providerSelectionStore = new ProviderSelectionStore(
  providerSelectionFileIo(providerSelectionFilePath(config.storage.dbPath)),
  new ConsoleLogger('provider-selection'),
);
logImageUnderstandingSelection(config.imageUnderstanding, new ConsoleLogger('image-understanding'));
const providerCatalog = new ProviderCatalog({
  ai: config.ai,
  vision: visionModelsOf(config),
  ...(providerSelectionStore.get().chat ? { persistedChat: providerSelectionStore.get().chat } : {}),
  ...(providerSelectionStore.get().image ? { persistedImage: providerSelectionStore.get().image } : {}),
  cliPresent: (bin) => isCliPresent(bin),
  // ADR-0098 D8: opt-in local embeddings (QUOKY_EMBEDDING_ENABLED, default false). Advertises only EMBEDDING and runs
  // in the runner's default profile like Ollama chat; it never pulls a model.
  extra: config.embedding.enabled
    ? [
        new OllamaCliEmbeddingProvider({
          bin: config.ai.ollamaBin,
          model: config.embedding.model,
          timeoutMs: config.embedding.timeoutMs,
        }),
      ]
    : [],
  logger: new ConsoleLogger('ai-providers'),
});
const runtimeProviderRouting = createProductionRuntimeProviderRoutingActivation({
  mode: config.providerRoutingMode,
  ollama: { ollamaBin: config.ai.ollamaBin },
});

// Sprint 4b (ADR-0061): GitHub App authentication for RepositoryHosting (CAP-010) + git push/clone (CAP-002).
// Resolve the reviewed identity (independent of credentials), then select the auth mode and construct the hosting
// adapter + the App-auth git decorator ONLY when auth is fully configured; otherwise the capability is
// "not configured" and fails safe. The App private key / minted token are ADAPTER-LOCAL: passed ONLY into
// @quoky/github-app-auth here; never into @quoky/core, ConversationRuntime, anchors, ApprovalRequest.reason,
// logs, or Discord. `manager` reaches ConversationRuntime as `RepositoryHostingManager | undefined` — never a token.
const repositoryIdentityResolution = new RepositoryIdentityResolver().resolve(config.repositoryHosting);
const repositoryIdentity =
  repositoryIdentityResolution.status === 'resolved' ? repositoryIdentityResolution.identity : undefined;
// ADR-0109 D1/D2: the validated allowlist (QUOKY_GITHUB_REPOS, or the legacy pair as an allowlist of one). Each
// registered project's repository is derived from its workspace origin and must be on it; with no allowlist the
// per-workspace resolver is absent and every hosting path stays "not configured" exactly as before.
const repositoryAllowlist = new RepositoryAllowlist(config.repositoryAllowlist);
const workspaceRepositoryResolver =
  repositoryAllowlist.size > 0 ? new WorkspaceRepositoryIdentityResolver({ allowlist: repositoryAllowlist }) : undefined;

const appConfigured = config.githubApp !== undefined;
const devPatToken = (config.githubToken ?? '').trim();
const patConfigured = devPatToken.length > 0;
const isDevRuntime = config.runtimeEnv === 'dev';

// Auth-mode selection (ADR-0061 §10.2). prod: App-only; PAT-only rejected; App+PAT rejected as ambiguous.
// dev: App precedence; PAT fallback allowed. "Rejected" → not configured (fail-safe; a sanitized warning, no secret).
let hostingAuthMode: 'github-app' | 'pat' | 'none';
if (appConfigured && patConfigured) {
  if (isDevRuntime) {
    hostingAuthMode = 'github-app';
  } else {
    hostingAuthMode = 'none';
    coreLogger.warn(
      'repository hosting: both GitHub App and PAT are configured in a non-dev runtime — rejected as ambiguous; capability not configured',
    );
  }
} else if (appConfigured) {
  hostingAuthMode = 'github-app';
} else if (patConfigured) {
  if (isDevRuntime) {
    hostingAuthMode = 'pat';
  } else {
    hostingAuthMode = 'none';
    coreLogger.warn(
      'repository hosting: PAT auth is not allowed in a non-dev runtime (GitHub App required) — capability not configured',
    );
  }
} else {
  hostingAuthMode = 'none';
}

let repositoryHostingManager: RepositoryHostingManager | undefined;
const connectorProviders = [...createConnectorProviders(config.connectors, coreLogger)];
// GIT_PROVIDER default: the plain LocalGitProvider (local ops + dev-PAT/ambient-credential git). Replaced by the
// App-auth decorator only in github-app mode, so git push/clone uses a minted installation token via GIT_ASKPASS.
let gitProvider: GitProvider = new LocalGitProvider();

if (hostingAuthMode === 'github-app' && repositoryAllowlist.size > 0 && config.githubApp) {
  const appAuth = new GitHubAppAuth({ appId: config.githubApp.appId, privateKeyPem: config.githubApp.privateKeyPem });
  // ADR-0109 D3 (unchanged ADR-0061 §8.4 down-scoping): every repository token is minted by tokenForRepository for
  // exactly the ONE allowlisted repository the operation resolved (numeric repository_ids + minimal permissions);
  // a non-allowlisted identity throws before any installation lookup or mint. The installation id is the explicit env
  // id, else resolved and cached per repository. "Not installed" or "repo not accessible" throws → surfaced
  // pre-mutation upstream (Blocked / not-configured); there is no broad write-token fallback. The separate Personal
  // Work connector source requests read-only issues/pull_requests permissions for discovery.
  // PR status preview reads with its OWN read-only, repo-down-scoped token ({pull_requests, checks, contents}: read).
  // If the App lacks the Checks permission the mint is refused (422) and the source re-mints without `checks`, so
  // the preview is PARTIAL (state + reviews, checks "unavailable") instead of failing. The push/PR-create token is
  // unchanged (contents + pull_requests write only). Merge preflight keeps using that token and never reads checks.
  const { tokenSource, statusTokenSource, readTokenSource } = createGitHubAppTokenSources({
    minter: appAuth,
    allowlist: repositoryAllowlist,
    ...(config.githubAppInstallationId !== undefined ? { installationId: config.githubAppInstallationId } : {}),
    createStatusTokenSource: (mint) => createPullRequestStatusTokenSource(mint, isPermissionNotGrantedError),
  });
  repositoryHostingManager = new RepositoryHostingManager(
    new GitHubRepositoryHostingProvider({ auth: { kind: 'github-app', tokenSource, statusTokenSource } }),
  );
  connectorProviders.push(new GitHubConnectorProvider({ auth: { kind: 'github-app', tokenSource: readTokenSource } }));
  gitProvider = new GitHubAppGitProvider({
    makeLocalGit: (runner) => new LocalGitProvider(runner),
    tokenSource,
    allowlist: repositoryAllowlist,
  });
} else if (hostingAuthMode === 'pat' && repositoryAllowlist.size > 0) {
  repositoryHostingManager = new RepositoryHostingManager(
    new GitHubRepositoryHostingProvider({ auth: { kind: 'pat', token: devPatToken } }),
  );
  connectorProviders.push(new GitHubConnectorProvider({ auth: { kind: 'pat', token: devPatToken } }));
  // Dev PAT (ADR-0061 §11.3): REST here; git push gets the same PAT through the askpass decorator below (ADR-0109).
}
// ADR-0109 review (rounds 2-3): whenever an allowlist is configured, every remote git op — in EVERY auth mode — runs
// through the same decorator: bound to the APPROVED repository passed by the runtime, against its canonical URL, with
// isolated git config (no system/global config, no inherited GIT_CONFIG_*, credential helpers reset). Because the
// owner's credential helpers are isolated away, dev PAT mode supplies its credential like App mode does: the configured
// PAT through the one-shot askpass. With no hosting credential the git child gets none. With no allowlist the plain
// LocalGitProvider stays, exactly as before.
if (!(gitProvider instanceof GitHubAppGitProvider) && repositoryAllowlist.size > 0) {
  gitProvider = new GitHubAppGitProvider({
    makeLocalGit: (runner) => new LocalGitProvider(runner),
    allowlist: repositoryAllowlist,
    ...(hostingAuthMode === 'pat' ? { tokenSource: async () => devPatToken } : {}),
  });
}
// ADR-0094: Personal-edition git safety, OUTERMOST so a refusal (remote off, commit on main/master) happens
// before any git process or the GitHub App decorator could mint a token. Wraps both composed branches above.
// ADR-0099 D5: the merge chain (main sync, post-merge local cleanup) additionally needs QUOKY_GIT_MERGE_ENABLED.
gitProvider = new PersonalGitGuard(gitProvider, {
  remoteEnabled: config.git.remoteEnabled,
  mergeEnabled: config.git.mergeEnabled,
});
// ADR-0094: with QUOKY_GIT_REMOTE_ENABLED=false the REST remote mutations (PR create, merge, remote branch
// delete) must be unreachable too, including from a stale apply-preview anchor (PR_CREATED / MERGE_APPROVED)
// in an older database. No manager means the runtime replies "not configured" before any token is minted.
// ADR-0099 D5: with remote on, the manager is wrapped in PersonalHostingGuard — PR create and PR status delegate;
// PR merge and remote branch delete are refused pre-mutation unless QUOKY_GIT_MERGE_ENABLED=true.
const repositoryHosting = {
  identity: repositoryIdentity,
  // ADR-0109 D2: present whenever an allowlist is configured — replaces `identity` for every remote step.
  ...(workspaceRepositoryResolver
    ? { resolveIdentity: (rootPath: string) => workspaceRepositoryResolver.resolve(rootPath) }
    : {}),
  manager:
    config.git.remoteEnabled && repositoryHostingManager
      ? new PersonalHostingGuard(repositoryHostingManager, { mergeEnabled: config.git.mergeEnabled })
      : undefined,
};

/**
 * Port -> concrete bindings. Swapping an implementation (e.g. Postgres storage,
 * git-worktree workspace, Telegram platform) means changing ONLY these lines.
 */
const infrastructure: Provider[] = [
  { provide: STORAGE_PROVIDER, useFactory: () => new SqliteStorageProvider({ dbPath: config.storage.dbPath }) },
  {
    provide: CONTINUATION_BINDING_REPOSITORY,
    // Storage repositories become available at init, after DI construction. Resolve at call time.
    useFactory: (storage: SqliteStorageProvider): ContinuationBindingRepository => ({
      get: id => storage.continuationBindings.get(id),
      admit: expected => storage.continuationBindings.admit(expected),
    }),
    inject: [STORAGE_PROVIDER],
  },
  { provide: QUEUE_PROVIDER, useFactory: () => new LocalQueueProvider() },
  { provide: VECTOR_PROVIDER, useFactory: () => new LocalVectorProvider(config.vector.storePath) },
  {
    provide: WORKSPACE_PROVIDER,
    useFactory: () => new LocalCloneWorkspaceProvider({ workspaceRoot: config.workspace.workspaceRoot }),
  },
  // CAP-002 Git. Separate port from Workspace — Workspace ≠ Git. In github-app auth mode the inner provider is the
  // GitHubAppGitProvider decorator (App-token push/clone via one-shot GIT_ASKPASS; ADR-0061); otherwise the plain
  // LocalGitProvider (itself unchanged). Either way it is wrapped by PersonalGitGuard (ADR-0094).
  { provide: GIT_PROVIDER, useFactory: () => gitProvider },
  // CAP-006 Workspace Write — applies PatchSet operations to the filesystem (node:fs only).
  { provide: WORKSPACE_WRITER, useFactory: () => new LocalWorkspaceWriter() },
  // CAP-007 Command Execution — runs commands via argv-array spawn, no shell (child_process).
  { provide: COMMAND_RUNNER, useFactory: () => new LocalCommandRunner() },
  {
    provide: PLATFORM_ADAPTER,
    // ADR-0091: the owner/channel admission gate is Discord-adapter config; Core never receives these ids.
    // ADR-0101 D8: the reminder channel-delivery opt-in reaches the adapter here (inert while reminders are off).
    useFactory: () =>
      new DiscordPlatformAdapter(
        withReminderChannelDelivery(config.discord, config.reminders),
        new ConsoleLogger('discord'),
      ),
  },
  {
    provide: AI_PROVIDERS,
    // Real CLI execution. Selection is by capability via the router, with the owner's selection as the router's
    // ProviderSelectionPolicy (ADR-0092 + amendments; ADR-0111 + amendments). The list is the catalog's live list: a
    // chat-tier choice of a non-default Claude alias or Ollama model adds one bounded, chat-tier-only instance to it.
    // A real readiness probe keeps an unready provider from being selected, so the router falls back to Claude.
    useFactory: (): AiProvider[] => providerCatalog.providers,
  },
  { provide: CONNECTOR_PROVIDERS, useValue: connectorProviders },
  // CAP-012 foundation: immutable empty registry until a separately approved adapter is composed.
  { provide: TOOL_PROVIDERS, useValue: [] satisfies readonly ToolProvider[] },
];

/**
 * Application services. These are pure-core classes wired EXPLICITLY (useFactory
 * + inject tokens) so the core needs no NestJS decorators and no type-based DI
 * metadata — keeping it framework-agnostic.
 */
const application: Provider[] = [
  // ADR-0089: validated static configuration becomes one immutable composition-time snapshot.
  createAgentProfileRegistryProvider(config.agentProfiles),
  continuationLifecycleProvider,
  continuationExecutionEntryProvider,
  continuationExecutionProvider,
  toolManagerProvider,
  {
    provide: ActorIdentityProvisioner,
    useFactory: (storage: StorageProvider) => new ActorIdentityProvisioner(storage, config.actorIdentityMappings),
    inject: [STORAGE_PROVIDER],
  },
  { provide: RiskPolicy, useFactory: () => new RiskPolicy() },
  { provide: ResponseComposer, useFactory: () => new ResponseComposer() },
  {
    provide: AiProviderManager,
    // Readiness is re-probed lazily with a backed-off interval for "not ready" providers, so a daemon that starts after
    // the service (Ollama at login) becomes usable without a restart; the change is logged once.
    useFactory: (ai: readonly AiProvider[]) => new AiProviderManager(ai, { logger: new ConsoleLogger('quoky') }),
    inject: [AI_PROVIDERS],
  },
  {
    provide: CapabilityRouter,
    // ADR-0092 amendment (runtime switching): the owner's effective selection is the router's policy (data only).
    useFactory: (manager: AiProviderManager, selection: ProviderSelectionService) => new CapabilityRouter(manager, selection),
    inject: [AiProviderManager, ProviderSelectionService],
  },
  // CAP-008: provider selection is consumed via the ProviderSelector port
  // (CapabilityRouter is its implementation), so the AI capability depends on the
  // selection contract, not the concrete router.
  {
    provide: PROVIDER_SELECTOR,
    useFactory: (router: CapabilityRouter): ProviderSelector => router,
    inject: [CapabilityRouter],
  },
  {
    provide: ActorManager,
    useFactory: (storage: StorageProvider) => new ActorManager(storage),
    inject: [STORAGE_PROVIDER],
  },
  {
    provide: SessionManager,
    useFactory: (storage: StorageProvider) => new SessionManager(storage),
    inject: [STORAGE_PROVIDER],
  },
  {
    provide: TaskManager,
    useFactory: (storage: StorageProvider) => new TaskManager(storage),
    inject: [STORAGE_PROVIDER],
  },
  {
    provide: MemoryManager,
    useFactory: (storage: StorageProvider, vector: VectorProvider) => new MemoryManager(storage, vector),
    inject: [STORAGE_PROVIDER, VECTOR_PROVIDER],
  },
  {
    provide: ArtifactManager,
    useFactory: (storage: StorageProvider) => new ArtifactManager(storage),
    inject: [STORAGE_PROVIDER],
  },
  {
    provide: WorkspaceManager,
    useFactory: (workspace: WorkspaceProvider) => new WorkspaceManager(workspace),
    inject: [WORKSPACE_PROVIDER],
  },
  {
    provide: GitManager,
    useFactory: (git: GitProvider) => new GitManager(git),
    inject: [GIT_PROVIDER],
  },
  // CAP-003 Planning. Strategy behind a port (deterministic only in v2);
  // PlanningManager stays thin and imports no other capability manager.
  {
    provide: EXECUTION_PLANNER,
    useFactory: (risk: RiskPolicy) => new DeterministicPlanner(risk),
    inject: [RiskPolicy],
  },
  {
    provide: PlanningManager,
    useFactory: (planner: ExecutionPlanner) => new PlanningManager(planner),
    inject: [EXECUTION_PLANNER],
  },
  // CAP-004 Approval (domain + policy + manager + persistence). Not wired into
  // the orchestrator / Discord flow yet (deferred).
  {
    provide: ApprovalPolicy,
    useFactory: (risk: RiskPolicy) => new ApprovalPolicy(risk),
    inject: [RiskPolicy],
  },
  {
    provide: ApprovalManager,
    useFactory: (storage: StorageProvider, policy: ApprovalPolicy) =>
      new ApprovalManager(storage, policy),
    inject: [STORAGE_PROVIDER, ApprovalPolicy],
  },
  // CAP-005 Patch (generation only). Not orchestrator/Discord wired.
  {
    provide: PatchManager,
    useFactory: (storage: StorageProvider) => new PatchManager(storage),
    inject: [STORAGE_PROVIDER],
  },
  // CAP-006 Workspace Write (apply PatchSet). Not orchestrator/Discord wired.
  {
    provide: WorkspaceWriteManager,
    useFactory: (storage: StorageProvider, writer: WorkspaceWriter) =>
      new WorkspaceWriteManager(storage, writer),
    inject: [STORAGE_PROVIDER, WORKSPACE_WRITER],
  },
  // CAP-007 Command Execution (gate + run + record). Not orchestrator/Discord wired.
  {
    provide: CommandExecutionManager,
    useFactory: (storage: StorageProvider, runner: CommandRunner, risk: RiskPolicy) =>
      new CommandExecutionManager(storage, runner, risk),
    inject: [STORAGE_PROVIDER, COMMAND_RUNNER, RiskPolicy],
  },
  {
    provide: ExecutionReceiptManager,
    useFactory: (storage: StorageProvider) => new ExecutionReceiptManager(storage),
    inject: [STORAGE_PROVIDER],
  },
  {
    provide: CommandExecutionReceiptRunner,
    useFactory: (command: CommandExecutionManager, receipts: ExecutionReceiptManager) =>
      new CommandExecutionReceiptRunner(command, receipts),
    inject: [CommandExecutionManager, ExecutionReceiptManager],
  },
  // CAP-008 AI Code Generation (compose → render → select → execute → parse → record).
  // Reuses the AiProvider port via ProviderSelector; not orchestrator/Discord wired.
  {
    provide: PromptRenderer,
    useFactory: () => new PromptRenderer(),
  },
  {
    provide: CodeGenerationManager,
    useFactory: (
      storage: StorageProvider,
      selector: ProviderSelector,
      promptComposer: PromptComposer,
      promptRenderer: PromptRenderer,
    ) => new CodeGenerationManager(storage, selector, promptComposer, promptRenderer),
    inject: [STORAGE_PROVIDER, PROVIDER_SELECTOR, PromptComposer, PromptRenderer],
  },
  {
    provide: ConnectorManager,
    useFactory: (connectors: readonly ConnectorProvider[]) => new ConnectorManager(connectors),
    inject: [CONNECTOR_PROVIDERS],
  },
  {
    provide: WorkSurfaceQuery,
    useFactory: (connectors: ConnectorManager) => new WorkSurfaceQuery(connectors),
    inject: [ConnectorManager],
  },
  {
    provide: WorkManager,
    useFactory: (storage: StorageProvider) => new WorkManager(storage),
    inject: [STORAGE_PROVIDER],
  },
  {
    provide: WorkHandoffManager,
    useFactory: (storage: StorageProvider, profiles: AgentProfileRegistry) =>
      new WorkHandoffManager(storage, profiles),
    inject: [STORAGE_PROVIDER, AgentProfileRegistry],
  },
  {
    provide: IntentClassifier,
    useFactory: (router: CapabilityRouter) => new IntentClassifier(router),
    inject: [CapabilityRouter],
  },
  {
    provide: Planner,
    useFactory: (router: CapabilityRouter, risk: RiskPolicy) => new Planner(router, risk),
    inject: [CapabilityRouter, RiskPolicy],
  },
  {
    provide: ContextBuilder,
    // ADR-0098 D8: semantic recall is composed only when embeddings are enabled; otherwise recall stays lexical.
    // ADR-0107 D5 (LRN-2): the curated-example layer is composed only when QUOKY_LEARNING_EXAMPLES_ENABLED=true
    // (default false); PromptComposer still layers examples only for a provider that declares LOCAL execution, or —
    // ADR-0116, QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED=true (default false) — a REMOTE one the owner explicitly selected.
    useFactory: (
      memory: MemoryManager,
      storage: StorageProvider,
      selector: ProviderSelector,
      vectors: VectorProvider,
      learning: LearningRepository,
    ) =>
      createProductionContextBuilder(
        memory,
        storage,
        config.contextBuilder,
        config.embedding.enabled
          ? {
              selector,
              vectors,
              timeoutMs: config.embedding.timeoutMs,
              maxNewPerTurn: config.embedding.maxNewPerTurn,
              logger: new ConsoleLogger('recall'),
            }
          : undefined,
        curatedExampleOptionsOf(config, learning, new ConsoleLogger('learning-examples')),
      ),
    inject: [MemoryManager, STORAGE_PROVIDER, PROVIDER_SELECTOR, VECTOR_PROVIDER, LEARNING_REPOSITORY],
  },
  { provide: PromptComposer, useFactory: () => new PromptComposer() },
  {
    provide: ProjectManager,
    useFactory: (
      storage: StorageProvider,
      workspace: WorkspaceManager,
      memory: MemoryManager,
      sessions: SessionManager,
    ) => new ProjectManager(storage, workspace, memory, sessions),
    inject: [STORAGE_PROVIDER, WorkspaceManager, MemoryManager, SessionManager],
  },
  {
    provide: ProjectAnalyzer,
    useFactory: (storage: StorageProvider, workspace: WorkspaceManager) =>
      new ProjectAnalyzer(storage, workspace),
    inject: [STORAGE_PROVIDER, WorkspaceManager],
  },
  // Sprint 2j — Intent Resolver + Execution Orchestrator (Application-Layer composition).
  { provide: IntentResolver, useFactory: () => new IntentResolver() },
  {
    provide: ExecutionOrchestrator,
    useFactory: (
      planning: PlanningManager,
      codeGeneration: CodeGenerationManager,
      workspace: WorkspaceManager,
      approval: ApprovalManager,
      patch: PatchManager,
      workspaceWrite: WorkspaceWriteManager,
      command: CommandExecutionReceiptRunner,
    ) =>
      new ExecutionOrchestrator({
        planning,
        codeGeneration,
        workspace,
        approval,
        patch,
        workspaceWrite,
        command,
        logger: coreLogger,
      }),
    inject: [
      PlanningManager,
      CodeGenerationManager,
      WorkspaceManager,
      ApprovalManager,
      PatchManager,
      WorkspaceWriteManager,
      CommandExecutionReceiptRunner,
    ],
  },
  // Sprint 2k — Conversation Runtime (the single conversation entry; ADR-0032). QuokyCore
  // (below) is a thin facade that delegates to it. Approval-awaiting state is DERIVED from existing
  // aggregates (Session.activeTaskId → Task.planId → approvals.findByExecutionPlan → PENDING); the
  // runtime persists no state and writes no snapshot to Session.
  {
    provide: ConversationRuntime,
    useFactory: (
      storage: StorageProvider,
      actors: ActorManager,
      sessions: SessionManager,
      memory: MemoryManager,
      classifier: IntentClassifier,
      projectManager: ProjectManager,
      analyzer: ProjectAnalyzer,
      tasks: TaskManager,
      workspace: WorkspaceManager,
      contextBuilder: ContextBuilder,
      promptComposer: PromptComposer,
      promptRenderer: PromptRenderer,
      router: CapabilityRouter,
      artifacts: ArtifactManager,
      composer: ResponseComposer,
      workSurface: WorkSurfaceQuery,
      intentResolver: IntentResolver,
      orchestrator: ExecutionOrchestrator,
      approvals: ApprovalManager,
      commandExecutions: CommandExecutionManager,
      codeGeneration: CodeGenerationManager,
      patch: PatchManager,
      workspaceWrite: WorkspaceWriteManager,
      git: GitManager,
      turnHandlers: readonly ConversationTurnHandler[],
      connectorWriteFlow: ConnectorWriteFlow | null,
      providerSelection: ProviderSelectionService,
    ) => {
      // ADR-0032: production ApprovalFlow — stateless, derived from existing aggregates
      // (Session.activeTaskId → Task.planId → approvals.findByExecutionPlan → PENDING); anchors the
      // in-flight {request, prior} on the in-focus Task so a later turn can resume. No new store.
      // Track A / ADR-0062 (Sprint 4c-Follow-up-2) — pass the LIVE storage seam to the stateless flows, never an
      // eager { sessions: storage.sessions, tasks: storage.tasks } snapshot. This factory runs during
      // NestFactory.createApplicationContext (main.ts) BEFORE `await storage.init()`, and the sqlite
      // StorageProvider's repositories (`sessions!`/`tasks!`/`approvals!`) are undefined until init() assigns them.
      // Capturing the values here froze `undefined` into the flow, so a later `.save()` threw
      // "Cannot read properties of undefined (reading 'save')". The flows already dereference `store.sessions`/
      // `store.tasks` at CALL time (post-init) — mirroring SessionManager — so holding the live `storage` object
      // resolves the initialized repos. `StorageProvider` structurally satisfies each flow's narrowed store.
      const approvalFlow = new StatelessApprovalFlow(storage);
      // ADR-0037: production ScopeClarificationFlow — one step earlier (before any ExecutionPlan exists). The
      // anchored Task is an inert conversation anchor, distinguished from an approval anchor by planId absence.
      const scopeClarificationFlow = new StatelessScopeClarificationFlow(storage);
      // ADR-0040: production ApplyPreviewFlow — a plan-less inert conversation anchor, never discoverable by
      // StatelessApprovalFlow's plan-scoped lookup.
      const applyPreviewFlow = new StatelessApplyPreviewFlow(storage);
      // ADR-0097: the one-time, hash-bound CRITICAL credential-guard override — grants live only on its inert
      // plan-less anchor Task (same live storage seam, ADR-0062); the shared clock bounds its 30-minute TTL.
      const credentialOverrideFlow = new StatelessCredentialOverrideFlow(storage);
      return createProductionConversationRuntime(memory, {
        dispatchCommit: createProviderDispatchCommit(storage),
        actors,
        sessions,
        memory,
        classifier,
        // register via ProjectManager; get via the existing projects repository (ADR-0033 read path).
        projects: {
          register: (path, session) => projectManager.register(path, session),
          get: (id) => storage.projects.get(id),
        },
        analyzer,
        tasks,
        workspace,
        commandExecutions,
        // ADR-0043: reuses the same, already-injected CommandExecutionManager (the sole command runner) as
        // the post-apply validation runner — no new provider/import/inject; runs only pnpm test/typecheck.
        command: commandExecutions,
        contextBuilder,
        promptComposer,
        promptRenderer,
        router,
        artifacts,
        composer,
        workSurface,
        intentResolver,
        orchestrator,
        approvals,
        approvalFlow,
        scopeClarificationFlow,
        applyPreviewFlow,
        // ADR-0038: reuses the same, already-registered CodeGenerationManager provider
        // ExecutionOrchestrator already depends on — no new provider.
        codeGeneration,
        // ADR-0041: reuses the same, already-registered PatchManager provider (representation-only) and
        // storage.codeProposals — no new provider.
        patch,
        codeProposals: { get: (id) => storage.codeProposals.get(id) },
        // ADR-0042: reuses the same, already-registered WorkspaceWriteManager provider (the sole file
        // mutator) ExecutionOrchestrator already depends on — no new provider.
        workspaceWrite,
        // ADR-0044: reuses the already-registered GitManager (CAP-002) for the read-only post-apply git
        // preview — status + the new read-only diff extension only; no new provider, no git mutation.
        git,
        // ADR-0054: Repository Hosting (CAP-010) for actual PR creation execution — resolved identity +
        // RepositoryHostingManager (present only when a GitHub token is configured). NO token is passed here.
        // The runtime calls the manager only, never GitHubRepositoryHostingProvider directly.
        repositoryHosting,
        runtimeProviderRouting,
        // ADR-0096: the statically composed turn-handler registry (features/*.providers.ts → aggregator).
        turnHandlers,
        // ADR-0097 (deps baseline 33 → 34): the credential-guard override flow.
        credentialOverrideFlow,
        // ADR-0112 D5 (deps baseline 34 → 35): connector writes behind exact-payload one-time CRITICAL approvals;
        // `undefined` when no writer is built (every write request keeps its fixed "writes are off" reply).
        connectorWriteFlow: connectorWriteFlow ?? undefined,
        logger: coreLogger,
      }, {
        gitRemoteEnabled: config.git.remoteEnabled,
        gitMergeEnabled: config.git.mergeEnabled,
        // ADR-0111 amendment A2 + runtime switching: LOCAL only unless the EFFECTIVE image selection (session override →
        // operations-UI default → configuration) is the cloud (Claude) image provider — resolved per image turn.
        imageUnderstandingLocalities: (context) => providerSelection.imageLocalities(context),
      });
    },
    inject: [
      STORAGE_PROVIDER,
      ActorManager,
      SessionManager,
      MemoryManager,
      IntentClassifier,
      ProjectManager,
      ProjectAnalyzer,
      TaskManager,
      WorkspaceManager,
      ContextBuilder,
      PromptComposer,
      PromptRenderer,
      CapabilityRouter,
      ArtifactManager,
      ResponseComposer,
      WorkSurfaceQuery,
      IntentResolver,
      ExecutionOrchestrator,
      ApprovalManager,
      CommandExecutionManager,
      CodeGenerationManager,
      PatchManager,
      WorkspaceWriteManager,
      GitManager,
      CONVERSATION_TURN_HANDLERS,
      CONNECTOR_WRITE_FLOW,
      ProviderSelectionService,
    ],
  },
  // Thin platform-entry facade (ADR-0032): delegates to ConversationRuntime, then delivers.
  // ADR-0098 D3/D5: it also records each delivered turn (best-effort, content-free) and is the platform's feedback
  // subscriber — the `onFeedback` subscription lives here, not in main.ts. Reactions never produce a reply.
  {
    provide: QuokyCore,
    useFactory: (runtime: ConversationRuntime, platform: PlatformAdapter, feedback: FeedbackRecorder) => {
      const core = new QuokyCore({ runtime, platform, logger: coreLogger, feedback });
      platform.onFeedback?.((signal) =>
        core.handleFeedbackSignal(signal).catch((err: unknown) =>
          coreLogger.warn('feedback signal handling failed', {
            errorName: err instanceof Error ? err.name : typeof err,
          }),
        ),
      );
      return core;
    },
    inject: [ConversationRuntime, PLATFORM_ADAPTER, FeedbackRecorder],
  },
];

/**
 * Personal v2 feature composition (ADR-0096 D7). Each track registers its handlers and services only in its own
 * `features/<feature>.providers.ts`; the aggregator binds `CONVERSATION_TURN_HANDLERS` to their concatenation.
 */
const features: Provider[] = [
  ...codeWorkProviders,
  ...workChatProviders,
  ...remindersProviders,
  ...createFeedbackProviders({ remoteExamplesDisclosure: learningRemoteDisclosureOf(config) }),
  // ADR-0106 (MEM-1): memory management commands (pre-classify order 50) over the existing writer and vector cache.
  // ADR-0106 amendment: forgotten memories are archived for QUOKY_MEMORY_ARCHIVE_DAYS (default 7; 0 = delete at once).
  ...createMemoryProviders({ archiveDays: config.memory.archiveDays }),
  // ADR-0110 (CAL-2): schedule questions from the read-only calendar (pre-classify order 150). CALENDAR_READER and the
  // handler are bound only when the calendar is configured; otherwise QUAL-7 routing is unchanged (D5).
  // ADR-0110 amendment (CWR-2): with a calendar writer bound the handler's help line lists the approved write forms.
  ...createCalendarProviders({
    calendar: config.calendar,
    timeZone: config.reminders.timeZone,
    writesEnabled: connectorWrites.calendarWritesEnabled,
  }),
  // ADR-0112 (CWR-2): connector-write writers, receipts view and the optional runtime write flow.
  ...connectorWrites.providers,
  // ADR-0092 amendment (runtime switching): the effective selection service and the owner's model command (pre-classify 70).
  ...createProviderSelectionProviders({ config, catalog: providerCatalog, store: providerSelectionStore }),
  turnHandlersProvider,
];

@Module({
  providers: [...infrastructure, ...features, ...application],
})
export class AppModule {}

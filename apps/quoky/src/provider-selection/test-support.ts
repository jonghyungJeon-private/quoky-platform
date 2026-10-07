import { AiProviderManager, CapabilityRouter, SessionManager, SessionStatus } from '@quoky/core';
import type { AiProvider, AiRequest, OutboundMessage, Session, StorageProvider } from '@quoky/core';
import type { OllamaModelInventory } from '@quoky/ai-cli';
import { loadConfig } from '../config';
import { envImageSelectionOf, visionModelsOf } from '../image-understanding-provider';
import { ProviderCatalog } from './provider-catalog';
import { ProviderSelectionService } from './provider-selection-service';
import { ProviderSelectionStore, providerSelectionFileIo } from './selection-store';
import type { ProviderSelectionFileIo } from './selection-store';
import type { ChatChoice } from './selection-choices';

/**
 * Offline test support for the runtime model switch (ADR-0092 / ADR-0111 amendments). Not used by production code: it
 * builds the real catalog, service and router over the real config parser, with every provider's readiness and
 * execution replaced (nothing is spawned) and an in-memory session store.
 */

export const TEST_OWNER = '111111111111111111';

export interface SelectionFixtureOptions {
  readonly env?: Readonly<Record<string, string>>;
  /** CLI binaries present on the host (default: none). */
  readonly present?: readonly string[];
  readonly persistedChat?: ChatChoice;
  readonly io?: ProviderSelectionFileIo;
  readonly inventory?: OllamaModelInventory;
}

export interface SelectionFixture {
  readonly catalog: ProviderCatalog;
  readonly service: ProviderSelectionService;
  readonly router: CapabilityRouter;
  readonly manager: AiProviderManager;
  readonly store: ProviderSelectionStore;
  readonly sessions: SessionManager;
  readonly rows: Map<string, Session>;
  /** Readiness by provider id (default ready). */
  readonly ready: Map<string, boolean>;
  /** Provider ids whose `execute` ran, in order. */
  readonly executed: string[];
  readonly logs: Array<{ level: 'info' | 'warn'; message: string; fields?: Record<string, unknown> }>;
  inventory: OllamaModelInventory;
  openSession(id?: string): Promise<Session>;
}

function stub(provider: AiProvider, ready: Map<string, boolean>, executed: string[]): void {
  Object.assign(provider, {
    isAvailable: async () => ready.get(provider.id) ?? true,
    execute: async (request: AiRequest) => {
      executed.push(provider.id);
      return { text: `${provider.id}:${request.capability}`, artifacts: [] };
    },
  });
}

export function selectionFixture(options: SelectionFixtureOptions = {}): SelectionFixture {
  const config = loadConfig({ QUOKY_DISCORD_OWNER_IDS: TEST_OWNER, ...(options.env ?? {}) } as NodeJS.ProcessEnv);
  const ready = new Map<string, boolean>();
  const executed: string[] = [];
  const logs: SelectionFixture['logs'] = [];
  const logger = {
    info: (message: string, fields?: Record<string, unknown>) => logs.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message: string, fields?: Record<string, unknown>) => logs.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
  };
  const present = options.present ?? [];
  const catalog = new ProviderCatalog({
    ai: config.ai,
    vision: visionModelsOf(config),
    ...(options.persistedChat ? { persistedChat: options.persistedChat } : {}),
    cliPresent: (bin) => present.includes(bin),
    logger,
  });
  // Real adapter instances (construction spawns nothing); their probes and execution are replaced here, and every
  // on-demand chat-tier view the catalog adds later is replaced the same way as it is pushed.
  for (const provider of catalog.providers) stub(provider, ready, executed);
  const originalPush = catalog.providers.push.bind(catalog.providers);
  catalog.providers.push = (...added: AiProvider[]) => {
    for (const provider of added) stub(provider, ready, executed);
    return originalPush(...added);
  };

  const rows = new Map<string, Session>();
  const storage = {
    sessions: {
      async save(session: Session) {
        rows.set(session.id, structuredClone(session));
        return session;
      },
      async get(id: string) {
        const row = rows.get(id);
        return row ? structuredClone(row) : null;
      },
      async list() {
        return [...rows.values()].map((row) => structuredClone(row));
      },
      async findActiveByContext() {
        return null;
      },
    },
  } as unknown as StorageProvider;
  const sessions = new SessionManager(storage);
  const store = new ProviderSelectionStore(options.io ?? providerSelectionFileIo(undefined), logger);
  const manager = new AiProviderManager(catalog.providers, { availabilityTtlMs: 0 });
  const fixture: SelectionFixture = {
    catalog,
    store,
    manager,
    sessions,
    rows,
    ready,
    executed,
    logs,
    inventory: options.inventory ?? { status: 'OK', models: ['llama3.1:latest', 'granite3.3:8b'] },
    service: undefined as unknown as ProviderSelectionService,
    router: undefined as unknown as CapabilityRouter,
    async openSession(id = `s-${rows.size + 1}`) {
      const session: Session = {
        id,
        actorId: 'actor-owner',
        context: { platform: 'discord', channelId: `c-${id}`, userId: TEST_OWNER },
        status: SessionStatus.ACTIVE,
        createdAt: '2026-10-07T00:00:00.000Z',
        lastActivityAt: '2026-10-07T00:00:00.000Z',
      };
      rows.set(id, session);
      return session;
    },
  };
  const service = new ProviderSelectionService({
    catalog,
    envChat: {
      choice: { provider: config.ai.chat.provider },
      source: config.ai.chat.source === 'QUOKY_CHAT_PROVIDER' ? 'env' : 'default',
    },
    envImage: envImageSelectionOf(config),
    store,
    sessions: () => storage.sessions,
    updateSessionEntry: (sessionId, key, update) => sessions.updateMetadataEntry({ id: sessionId }, key, update),
    readiness: (provider) => manager.isReady(provider),
    ollamaModels: async () => fixture.inventory,
    logger,
    clock: () => '2026-10-07T01:00:00.000Z',
  });
  Object.assign(fixture, { service, router: new CapabilityRouter(manager, service) });
  return fixture;
}

/** The reply text of a handler outcome (test helper). */
export function replyText(outcome: { readonly reply?: OutboundMessage } | null): string {
  return outcome?.reply?.text ?? '';
}

/**
 * For the offline acceptance harnesses that boot the real `AppModule`: replace the runtime model switch's two host
 * touches on the container's instance — the Ollama inventory (`ollama list`) answers `inventory`, and every on-demand
 * model instance the catalog adds later is passed to `stub` as it is added (the harness stubs the static ones itself).
 */
export function stubProviderSelection(
  app: { get<T = unknown>(token: unknown): T },
  stub: (provider: AiProvider) => void,
  inventory: OllamaModelInventory = { status: 'OK', models: [] },
): void {
  const service = app.get<ProviderSelectionService>(ProviderSelectionService) as unknown as {
    deps: { ollamaModels: () => Promise<OllamaModelInventory>; catalog: ProviderCatalog };
  };
  service.deps.ollamaModels = async () => inventory;
  const providers = service.deps.catalog.providers;
  const push = providers.push.bind(providers);
  providers.push = (...added: AiProvider[]) => {
    for (const provider of added) stub(provider);
    return push(...added);
  };
}

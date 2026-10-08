import { afterEach, describe, expect, it } from 'vitest';
import {
  CURATED_EXAMPLES_SECTION_TITLE,
  Capability,
  IntentType,
  LEARNING_EGRESS_LOCAL_ONLY,
  LEARNING_MAX_ITEMS_PER_ACTOR,
  LearningItemKind,
  MemoryManager,
  PromptComposer,
  RiskLevel,
  TaskStatus,
  createLearningItemsRemovalCascade,
  executionLocalityOf,
  type ContextBundle,
  type LearningItem,
  type PromptSpec,
  type Task,
  type VectorProvider,
} from '@quoky/core';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { loadConfig } from './config';
import { createProductionContextBuilder, curatedExampleOptionsOf, learningRemoteDisclosureOf } from './context-builder-provider';
import { selectionFixture, TEST_OWNER } from './provider-selection/test-support';

/**
 * ADR-0116 (LRN-5) acceptance, offline: the PRODUCTION context builder over a real `:memory:` SQLite learning store, the
 * REAL selection policy and router (`selectionFixture`: real config parser, catalog, `ProviderSelectionService` and
 * `CapabilityRouter`; probes and execution stubbed), and the real `PromptComposer`, assembled the way the runtime's
 * work path does: build the bundle, resolve the provider WITH its selection source, compose with the provider's
 * declared locality and that source. No provider is executed.
 */

const ACTOR = 'actor-owner';
const NOW = '2026-10-08T00:00:00.000Z';
const QUESTION = '회의록 요약 형식 알려줘';
const storages: SqliteStorageProvider[] = [];
afterEach(async () => {
  await Promise.all(storages.splice(0).map((storage) => storage.close?.()));
});

function exampleItem(n: number, over: Partial<LearningItem> = {}, data: Partial<LearningItem['data']> = {}): LearningItem {
  return {
    id: `learning-item-${n}`,
    actorId: ACTOR,
    kind: LearningItemKind.EXAMPLE,
    capability: Capability.GENERAL_CHAT,
    language: 'ko',
    sourceTurnId: `turn-${n}`,
    egress: LEARNING_EGRESS_LOCAL_ONLY,
    createdAt: `2026-10-0${n}T00:00:00.000Z`,
    expiresAt: '2027-10-01T00:00:00.000Z',
    data: {
      requestText: `${QUESTION} ${n}`,
      idealAnswer: `핵심 결정과 담당자를 세 줄로 정리해요 (예시 ${n})`,
      sourceRating: 'POSITIVE',
      ...data,
    },
    ...over,
  };
}

const chatTask = (sessionId: string): Task => ({
  id: 'task-lrn5',
  title: QUESTION,
  description: QUESTION,
  status: TaskStatus.RUNNING,
  intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: QUESTION },
  riskLevel: RiskLevel.LOW,
  context: { platform: 'discord', channelId: 'c-lrn5', userId: TEST_OWNER },
  sessionId,
  actorId: ACTOR,
  createdAt: NOW,
  updatedAt: NOW,
});

async function harness(env: Record<string, string>, items: LearningItem[] = []) {
  const config = loadConfig({ QUOKY_DISCORD_OWNER_IDS: TEST_OWNER, ...env } as NodeJS.ProcessEnv);
  const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
  storages.push(storage);
  await storage.init();
  for (const item of items) {
    expect(await storage.learning.insertWithinCap(item, LEARNING_MAX_ITEMS_PER_ACTOR, NOW)).toBe('INSERTED');
  }
  const builder = createProductionContextBuilder(
    new MemoryManager(storage, {} as VectorProvider),
    storage,
    {},
    undefined,
    // The same mapping app.module.ts uses.
    curatedExampleOptionsOf(config, storage.learning),
  );
  const selection = selectionFixture({ env });
  const composer = new PromptComposer();
  /** One GENERAL_CHAT turn as the runtime's work path composes it (no provider is executed). */
  const turn = async (session: { readonly id: string }) => {
    const task = chatTask(session.id);
    const bundle = await builder.build(task);
    const resolved = await selection.router.resolve(Capability.GENERAL_CHAT, { sessionId: session.id, actorId: ACTOR });
    const spec = composer.compose(task, bundle, undefined, {
      executionLocality: executionLocalityOf(resolved.provider),
      selectionSource: resolved.source,
    });
    return { bundle, resolved, spec, bare: composer.compose(task, withoutExamples(bundle)) };
  };
  return { config, storage, selection, turn };
}

function withoutExamples(bundle: ContextBundle): ContextBundle {
  const { curatedExamples: _examples, ...rest } = bundle;
  return rest;
}

const exampleCount = (spec: PromptSpec) => spec.context.split('Example request:').length - 1;

describe('ADR-0116 learning-example egress through the production composition', () => {
  const items = [exampleItem(1), exampleItem(2), exampleItem(3)];
  const ON = { QUOKY_LEARNING_EXAMPLES_ENABLED: 'true', QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED: 'true' };

  it('flag off: an explicitly selected Claude gets a prompt byte-identical to today (no example layer)', async () => {
    const h = await harness({ QUOKY_LEARNING_EXAMPLES_ENABLED: 'true', QUOKY_CHAT_PROVIDER: 'claude' }, items);
    expect(h.config.learning.examplesRemoteEnabled).toBe(false);
    const { bundle, resolved, spec, bare } = await h.turn(await h.selection.openSession());
    expect(resolved).toMatchObject({ source: 'OWNER_SELECTED' });
    expect(executionLocalityOf(resolved.provider)).toBe('REMOTE');
    // The examples were selected (LOCAL_ONLY) but are not composed for the REMOTE provider.
    expect(bundle.curatedExamples?.map((e) => e.egress)).toEqual(['LOCAL_ONLY', 'LOCAL_ONLY']);
    expect(spec).toEqual(bare);
    expect(spec.context).not.toContain(CURATED_EXAMPLES_SECTION_TITLE);
  });

  it('flag on + Claude selected explicitly (env, operations-UI default, session override): at most 2 examples', async () => {
    const viaEnv = await harness({ ...ON, QUOKY_CHAT_PROVIDER: 'claude' }, items);
    const envTurn = await viaEnv.turn(await viaEnv.selection.openSession());
    expect([envTurn.resolved.provider.id, envTurn.resolved.source]).toEqual(['claude-cli', 'OWNER_SELECTED']);
    expect(exampleCount(envTurn.spec)).toBe(2);
    expect(envTurn.spec.context).toContain(`## ${CURATED_EXAMPLES_SECTION_TITLE}`);

    const viaOps = await harness({ ...ON, QUOKY_OLLAMA_ENABLED: 'false' }, items);
    viaOps.selection.service.setDefaultChat({ provider: 'claude' }, { surface: 'ops-ui', actor: 'owner' });
    expect(exampleCount((await viaOps.turn(await viaOps.selection.openSession())).spec)).toBe(2);

    const viaSession = await harness({ ...ON, QUOKY_OLLAMA_ENABLED: 'false' }, items);
    const session = await viaSession.selection.openSession();
    await viaSession.selection.service.setSessionChat(
      { sessionId: session.id, actorId: ACTOR },
      { provider: 'claude', model: 'opus' },
      { surface: 'chat', actor: ACTOR },
    );
    const sessionTurn = await viaSession.turn(session);
    expect(sessionTurn.resolved.provider.id).toBe('claude-cli:opus');
    expect(exampleCount(sessionTurn.spec)).toBe(2);
    // A new conversation without the override falls back to the derived default: none.
    expect(exampleCount((await viaSession.turn(await viaSession.selection.openSession())).spec)).toBe(0);
  });

  it("the owner's service config (QUOKY_CHAT_PROVIDER=claude + QUOKY_OLLAMA_ENABLED=false): OWNER_SELECTED, 2 examples", async () => {
    const h = await harness({ ...ON, QUOKY_CHAT_PROVIDER: 'claude', QUOKY_OLLAMA_ENABLED: 'false' }, items);
    const { resolved, spec } = await h.turn(await h.selection.openSession());
    expect([resolved.provider.id, resolved.source]).toEqual(['claude-cli', 'OWNER_SELECTED']);
    expect(exampleCount(spec)).toBe(2);
    // The same config with the remote flag off: byte-identical, no example layer.
    const off = await harness(
      { QUOKY_LEARNING_EXAMPLES_ENABLED: 'true', QUOKY_CHAT_PROVIDER: 'claude', QUOKY_OLLAMA_ENABLED: 'false' },
      items,
    );
    const offTurn = await off.turn(await off.selection.openSession());
    expect(offTurn.spec).toEqual(offTurn.bare);
  });

  it('flag on + Claude reached only as the derived default or as the selection-time fallback: none', async () => {
    // Derived default: QUOKY_CHAT_PROVIDER unset, QUOKY_OLLAMA_ENABLED=false read as claude (the owner's service).
    const derived = await harness({ ...ON, QUOKY_OLLAMA_ENABLED: 'false' }, items);
    const derivedTurn = await derived.turn(await derived.selection.openSession());
    expect([derivedTurn.resolved.provider.id, derivedTurn.resolved.source]).toEqual(['claude-cli', 'NOT_OWNER_SELECTED']);
    expect(derivedTurn.bundle.curatedExamples).toHaveLength(2);
    expect(derivedTurn.spec).toEqual(derivedTurn.bare);

    // Fallback: the explicitly chosen Codex is not ready, so Claude answers.
    const fallback = await harness({ ...ON, QUOKY_CHAT_PROVIDER: 'codex' }, items);
    fallback.selection.ready.set('codex-cli', false);
    const fallbackTurn = await fallback.turn(await fallback.selection.openSession());
    expect([fallbackTurn.resolved.provider.id, fallbackTurn.resolved.source]).toEqual(['claude-cli', 'NOT_OWNER_SELECTED']);
    expect(fallbackTurn.spec).toEqual(fallbackTurn.bare);
  });

  it('a forgotten example is never injected (예시 N 삭제 and the ADR-0106 memory-forget cascade)', async () => {
    const h = await harness({ ...ON, QUOKY_CHAT_PROVIDER: 'claude' }, [
      exampleItem(1),
      exampleItem(2, { sourceMemoryId: 'memory-2' }),
      exampleItem(3),
    ]);
    const session = await h.selection.openSession();
    const before = await h.turn(session);
    expect(before.bundle.curatedExamples?.map((e) => e.learningItemId).sort()).toEqual(['learning-item-2', 'learning-item-3']);

    expect(await h.storage.learning.delete(ACTOR, 'learning-item-3')).toBe(true);
    await createLearningItemsRemovalCascade(h.storage.learning).onMemoriesRemoved({
      actorId: ACTOR,
      reason: 'forget',
      memoryIds: ['memory-2'],
      vectorIds: [],
      contents: [],
    });
    const after = await h.turn(session);
    const text = JSON.stringify(after.spec);
    expect(text).not.toContain('(예시 2)');
    expect(text).not.toContain('(예시 3)');
    expect(after.bundle.curatedExamples?.map((e) => e.learningItemId)).toEqual(['learning-item-1']);
    expect(exampleCount(after.spec)).toBe(1);
  });

  it('a credential-bearing example is never injected, even when stored before the guard tightened', async () => {
    // Built by concatenation so no token-shaped literal appears in the source.
    const token = ['gh', 'p_', 'Q'.repeat(36)].join('');
    const h = await harness({ ...ON, QUOKY_CHAT_PROVIDER: 'claude' }, [
      exampleItem(1, {}, { idealAnswer: `토큰은 ${token} 이에요` }),
      exampleItem(2, {}, { requestText: `${QUESTION} ${token}` }),
      exampleItem(3),
    ]);
    const { spec } = await h.turn(await h.selection.openSession());
    const text = JSON.stringify(spec);
    expect(text).not.toContain(token);
    expect(text).not.toContain('[REDACTED');
    expect(exampleCount(spec)).toBe(1);
    expect(text).toContain('(예시 3)');
  });

  it('flag on + an explicitly selected local Ollama: the ADR-0107 LOCAL behaviour is unchanged', async () => {
    const h = await harness({ ...ON, QUOKY_CHAT_PROVIDER: 'ollama' }, items);
    const local = await h.turn(await h.selection.openSession());
    expect(executionLocalityOf(local.resolved.provider)).toBe('LOCAL');
    expect(exampleCount(local.spec)).toBe(2);
    const offRemote = await harness({ QUOKY_LEARNING_EXAMPLES_ENABLED: 'true', QUOKY_CHAT_PROVIDER: 'ollama' }, items);
    expect((await offRemote.turn(await offRemote.selection.openSession())).spec).toEqual(local.spec);
  });
});

describe('ADR-0116 egress is data-driven: the Gemini API (REMOTE, PRV-2) gets examples only when explicitly selected AND the flag is on', () => {
  const items = [exampleItem(1), exampleItem(2), exampleItem(3)];
  // Assembled at runtime from pieces: no token-shaped literal in the source.
  const GEMINI = { QUOKY_GEMINI_API_KEY: ['AI', 'za', 'L'.repeat(11), '5w'.repeat(12)].join(''), QUOKY_GEMINI_MODEL: 'gemini-3.5-flash-lite' };
  const ON = { QUOKY_LEARNING_EXAMPLES_ENABLED: 'true', QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED: 'true' };

  it('selected (QUOKY_CHAT_PROVIDER=gemini) with the flag off: REMOTE, OWNER_SELECTED, and still no example layer', async () => {
    const h = await harness({ QUOKY_LEARNING_EXAMPLES_ENABLED: 'true', QUOKY_CHAT_PROVIDER: 'gemini', ...GEMINI }, items);
    const { bundle, resolved, spec, bare } = await h.turn(await h.selection.openSession());
    expect([resolved.provider.id, resolved.source]).toEqual(['gemini-api', 'OWNER_SELECTED']);
    expect(executionLocalityOf(resolved.provider)).toBe('REMOTE');
    expect(bundle.curatedExamples).toHaveLength(2);
    expect(spec).toEqual(bare);
    expect(spec.context).not.toContain(CURATED_EXAMPLES_SECTION_TITLE);
  });

  it('selected explicitly (env, operations-UI default, session override) with the flag on: at most 2 examples', async () => {
    const viaEnv = await harness({ ...ON, QUOKY_CHAT_PROVIDER: 'gemini', ...GEMINI }, items);
    const envTurn = await viaEnv.turn(await viaEnv.selection.openSession());
    expect([envTurn.resolved.provider.id, envTurn.resolved.source]).toEqual(['gemini-api', 'OWNER_SELECTED']);
    expect(exampleCount(envTurn.spec)).toBe(2);

    const viaOps = await harness({ ...ON, QUOKY_OLLAMA_ENABLED: 'false', ...GEMINI }, items);
    viaOps.selection.service.setDefaultChat({ provider: 'gemini' }, { surface: 'ops-ui', actor: 'owner' });
    const opsTurn = await viaOps.turn(await viaOps.selection.openSession());
    expect(opsTurn.resolved.provider.id).toBe('gemini-api');
    expect(exampleCount(opsTurn.spec)).toBe(2);

    const viaSession = await harness({ ...ON, QUOKY_OLLAMA_ENABLED: 'false', ...GEMINI }, items);
    const session = await viaSession.selection.openSession();
    await viaSession.selection.service.setSessionChat(
      { sessionId: session.id, actorId: ACTOR },
      { provider: 'gemini', model: 'gemini-3.8-flash' },
      { surface: 'chat', actor: ACTOR },
    );
    const sessionTurn = await viaSession.turn(session);
    expect(sessionTurn.resolved.provider.id).toBe('gemini-api:gemini-3.8-flash');
    expect(exampleCount(sessionTurn.spec)).toBe(2);
    // A new conversation without the override is on the derived default (Claude, not an owner selection): none.
    const other = await viaSession.turn(await viaSession.selection.openSession());
    expect(other.resolved.provider.id).toBe('claude-cli');
    expect(exampleCount(other.spec)).toBe(0);
  });

  it('configured but not selected: Gemini is never the resolved provider, so no example can reach it', async () => {
    const h = await harness({ ...ON, QUOKY_OLLAMA_ENABLED: 'false', ...GEMINI }, items);
    const { resolved, spec, bare } = await h.turn(await h.selection.openSession());
    expect([resolved.provider.id, resolved.source]).toEqual(['claude-cli', 'NOT_OWNER_SELECTED']);
    expect(spec).toEqual(bare);
  });

  it('selected but not ready: Claude answers as the selection-time fallback and gets none', async () => {
    const h = await harness({ ...ON, QUOKY_CHAT_PROVIDER: 'gemini', ...GEMINI }, items);
    h.selection.ready.set('gemini-api', false);
    const { resolved, spec, bare } = await h.turn(await h.selection.openSession());
    expect([resolved.provider.id, resolved.source]).toEqual(['claude-cli', 'NOT_OWNER_SELECTED']);
    expect(spec).toEqual(bare);
  });
});

describe('ADR-0116 R4 learning copy disclosure follows the same condition as example egress', () => {
  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])('examplesEnabled=%s remote=%s -> disclose=%s', (examplesEnabled, examplesRemoteEnabled, expected) => {
    const config = { learning: { examplesEnabled, examplesRemoteEnabled } };
    expect(learningRemoteDisclosureOf(config)).toBe(expected);
    expect(learningRemoteDisclosureOf(config)).toBe(
      curatedExampleOptionsOf(config, { list: async () => [] })?.remoteOwnerSelected === true,
    );
  });
});

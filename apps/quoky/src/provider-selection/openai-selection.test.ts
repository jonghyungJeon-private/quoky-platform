import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capability, NoProviderAvailableError } from '@quoky/core';
import type { Actor, InboundMessage, Session, TurnHandlerContext } from '@quoky/core';
import { OpenAiApiProvider, OpenAiApiVisionProvider } from '@quoky/ai-openai-api';
import { inspect } from 'node:util';
import { stripInternalMetadataEnvelope } from '@quoky/ai-cli';
import { describeStartupFailure, reportProviderReadiness } from '../bootstrap-preflight';
import { composeChatProviders } from '../chat-provider-composition';
import { QuokyConfigErrorCode, loadConfig } from '../config';
import { openAiReplyHygiene } from '../openai-provider-composition';
import { OPS_CODEX_IMAGE_WARNING, OpsProviderSelectionActions, providerDefaultNoticeText } from '../ops-ui/actions/provider-selection-actions';
import { ModelSelectionTurnHandler } from './model-command-turn-handler';
import { CHAT_TIER_CAPABILITIES, CLAUDE_PINNED_CAPABILITIES } from './selection-choices';
import { TEST_OWNER, replyText, selectionFixture } from './test-support';

/**
 * ADR-0115 (PRV-1): the OpenAI API option in the owner's runtime switch — configuration and startup errors,
 * registration, the chat-tier-only eligibility, the image locality fence, the ADR-0092 amendment D4 invariant
 * extended to the new provider, the routing corpus with nothing selected, and key redaction. Every provider's probe and
 * execution is stubbed by the fixture; the platform `fetch` is replaced by a fake that fails the test if anything
 * reaches it unexpectedly. No test calls the real API.
 */

const FAKE_KEY = ['sk', 'quokyapp', 'K'.repeat(10) + '7x'.repeat(9)].join('-');
const OPENAI_ENV = { QUOKY_OPENAI_API_KEY: FAKE_KEY, QUOKY_OPENAI_MODEL: 'gpt-4.1-mini' } as const;
const ACTOR = 'actor-owner';
const scope = (session: { readonly id: string }) => ({ sessionId: session.id, actorId: ACTOR });
const OWNER_CHAT = { surface: 'chat' as const, actor: ACTOR };
const OPS = { surface: 'ops-ui' as const, actor: ACTOR };
const env = (extra: Record<string, string> = {}) => ({ QUOKY_DISCORD_OWNER_IDS: TEST_OWNER, ...extra }) as NodeJS.ProcessEnv;

const networkCalls: string[] = [];
beforeEach(() => {
  networkCalls.length = 0;
  vi.stubGlobal('fetch', (async (input: unknown) => {
    networkCalls.push(String(input));
    throw new Error('network access in an offline test');
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a throw');
}

describe('configuration (ADR-0115 D3/D6): off unless configured; typed startup errors that never echo a value', () => {
  it('neither variable set → no OpenAI provider (blank counts as unset)', () => {
    expect(loadConfig(env()).ai.openai).toBeUndefined();
    expect(loadConfig(env({ QUOKY_OPENAI_API_KEY: '', QUOKY_OPENAI_MODEL: '  ' })).ai.openai).toBeUndefined();
  });

  it('both set → the key (in a redacting holder) and the allow-listed model', () => {
    const openai = loadConfig(env(OPENAI_ENV)).ai.openai;
    expect(openai?.model).toBe('gpt-4.1-mini');
    expect(openai?.apiKey.reveal()).toBe(FAKE_KEY);
  });

  it('inspecting or serialising the whole configuration never shows the key (Codex P2)', () => {
    const config = loadConfig(env({ ...OPENAI_ENV, QUOKY_CHAT_PROVIDER: 'openai', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'openai' }));
    const views = [
      inspect(config, { depth: 10 }),
      inspect(config, { depth: 10, showHidden: true }),
      JSON.stringify(config),
      JSON.stringify({ ...config.ai.openai }),
      String(config.ai.openai?.apiKey),
    ];
    for (const view of views) expect(view).not.toContain(FAKE_KEY);
    expect(inspect(config, { depth: 10 })).toContain('OpenAiApiKey([REDACTED])');
    expect(JSON.stringify(config)).toContain('"apiKey":"[REDACTED]"');
  });

  it.each([
    [{ QUOKY_OPENAI_API_KEY: `${FAKE_KEY}"`, QUOKY_OPENAI_MODEL: 'gpt-4o' }, QuokyConfigErrorCode.OPENAI_API_KEY_INVALID],
    [{ QUOKY_OPENAI_API_KEY: `Bearer ${FAKE_KEY}`, QUOKY_OPENAI_MODEL: 'gpt-4o' }, QuokyConfigErrorCode.OPENAI_API_KEY_INVALID],
    [{ QUOKY_OPENAI_API_KEY: FAKE_KEY, QUOKY_OPENAI_MODEL: 'gpt-4o-secret-preview' }, QuokyConfigErrorCode.OPENAI_MODEL_INVALID],
    [{ QUOKY_OPENAI_API_KEY: FAKE_KEY, QUOKY_OPENAI_MODEL: 'GPT-4o' }, QuokyConfigErrorCode.OPENAI_MODEL_INVALID],
    [{ QUOKY_OPENAI_API_KEY: FAKE_KEY }, QuokyConfigErrorCode.OPENAI_MODEL_MISSING],
    [{ QUOKY_OPENAI_MODEL: 'gpt-4o' }, QuokyConfigErrorCode.OPENAI_API_KEY_MISSING],
    [{ QUOKY_CHAT_PROVIDER: 'openai' }, QuokyConfigErrorCode.OPENAI_API_KEY_MISSING],
    [{ QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'openai' }, QuokyConfigErrorCode.OPENAI_API_KEY_MISSING],
  ])('%j → %s', (vars, code) => {
    const err = thrown(() => loadConfig(env(vars)));
    expect((err as { code?: string }).code).toBe(code);
    expect(err.message).toBe(code);
    const report = describeStartupFailure(err);
    expect(report.hint).toBeDefined();
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
    expect(String(err.stack)).not.toContain(FAKE_KEY);
  });

  it('`openai` is accepted by both selectors once configured', () => {
    const config = loadConfig(env({ ...OPENAI_ENV, QUOKY_CHAT_PROVIDER: 'openai', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'openai' }));
    expect(config.ai.chat).toMatchObject({ provider: 'openai', source: 'QUOKY_CHAT_PROVIDER' });
    expect(config.imageUnderstanding).toEqual({ provider: 'openai' });
  });
});

describe('registration (ADR-0115 D3)', () => {
  it('registers the chat and image instances only when configured; otherwise the provider list is unchanged', () => {
    const without = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex', 'ollama'] });
    const withOpenAi = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...OPENAI_ENV }, present: ['codex', 'ollama'] });
    const ids = (f: typeof without) => f.catalog.providers.map((p) => p.id);
    expect(ids(without).some((id) => id.startsWith('openai'))).toBe(false);
    expect(ids(withOpenAi)).toEqual([...ids(without).filter((id) => !id.includes('vision')), 'openai-api', ...ids(without).filter((id) => id.includes('vision')), 'openai-vision-api']);
    expect(withOpenAi.catalog.openai?.executionLocality).toBe('REMOTE');
    expect(withOpenAi.catalog.openaiVision?.executionLocality).toBe('REMOTE');
    expect(networkCalls).toEqual([]);
  });

  it('the composition builds real adapters with the reply hygiene; construction makes no network call', () => {
    const config = loadConfig(env({ ...OPENAI_ENV, QUOKY_CHAT_PROVIDER: 'claude' }));
    const logs: unknown[] = [];
    const chat = composeChatProviders(config.ai, { info: (...a) => logs.push(a), warn: (...a) => logs.push(a) });
    expect(chat.openai).toBeInstanceOf(OpenAiApiProvider);
    expect(chat.providers.map((p) => p.id)).toEqual(['claude-cli', 'openai-api']);
    expect(JSON.stringify(logs)).not.toContain(FAKE_KEY);
    expect(networkCalls).toEqual([]);
  });
});

describe('eligibility: the OpenAI option answers only while it is the effective choice', () => {
  it('configured but not selected: no capability ever lists it; the chat tier stays on the configured choice', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude', ...OPENAI_ENV } });
    for (const capability of Object.values(Capability)) {
      const preference = await f.service.preferenceFor(capability, {});
      expect(preference?.eligible ?? [], capability).not.toContain('openai-api');
      expect(preference?.eligible ?? [], capability).not.toContain('openai-vision-api');
    }
    expect((await f.router.select(Capability.GENERAL_CHAT)).id).toBe('claude-cli');
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING)).id).toBe('claude-vision-cli');
  });

  it('selected for chat: the chat tier routes to it; code, review, planning, tests and policy stay on Claude', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'openai', ...OPENAI_ENV } });
    for (const capability of CHAT_TIER_CAPABILITIES) expect((await f.router.select(capability)).id, capability).toBe('openai-api');
    for (const capability of CLAUDE_PINNED_CAPABILITIES) expect((await f.router.select(capability)).id, capability).toBe('claude-cli');
    expect(await f.service.effectiveChat()).toMatchObject({ label: 'openai:gpt-4.1-mini', source: 'env' });
  });

  it('a not-ready OpenAI choice falls back to Claude at selection time, and status says so', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'openai', ...OPENAI_ENV } });
    f.ready.set('openai-api', false);
    expect((await f.router.select(Capability.GENERAL_CHAT)).id).toBe('claude-cli');
    expect((await f.service.status()).chat).toMatchObject({ label: 'openai:gpt-4.1-mini', ready: false, fallbackLabel: 'claude:sonnet' });
  });

  it('another allow-listed model is an on-demand chat-tier-only instance; a model off the list is refused', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...OPENAI_ENV } });
    const session = await f.openSession();
    const validated = await f.service.validateChatToken('openai:gpt-4o');
    expect(validated).toEqual({ ok: true, choice: { provider: 'openai', model: 'gpt-4o' } });
    if (!validated.ok) throw new Error('unreachable');
    await f.service.setSessionChat(scope(session), validated.choice, OWNER_CHAT);
    const chosen = await f.router.select(Capability.SUMMARIZATION, scope(session));
    expect(chosen.id).toBe('openai-api:gpt-4o');
    expect(chosen.capabilities.map((c) => c.capability).sort()).toEqual([...CHAT_TIER_CAPABILITIES].sort());
    expect((await f.router.select(Capability.CODE_REVIEW, scope(session))).id).toBe('claude-cli');
    expect(await f.service.validateChatToken('openai:o3')).toEqual({ ok: false, refusal: 'OPENAI_MODEL_NOT_ALLOWED' });
    // The configured model folds into the default instance.
    expect(await f.service.validateChatToken('openai:gpt-4.1-mini')).toEqual({ ok: true, choice: { provider: 'openai' } });
  });

  it('not configured: the option cannot be chosen, and a stale persisted or session choice is skipped', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    expect(await f.service.validateChatToken('openai')).toEqual({ ok: false, refusal: 'PROVIDER_NOT_ON_HOST' });
    expect(f.service.validateImageToken('openai')).toEqual({ ok: false, refusal: 'IMAGE_OPTION_UNAVAILABLE' });
    f.store.save({ chat: { provider: 'openai' }, image: 'openai', updatedAt: '2026-10-08T00:00:00.000Z' });
    expect(await f.service.effectiveChat()).toMatchObject({ label: 'claude:sonnet', ignored: ['persisted'] });
    expect(await f.service.effectiveImage()).toMatchObject({ choice: 'off', ignored: ['persisted'] });
  });
});

describe('the ADR-0092 amendment D4 invariant extended to the OpenAI provider (ADR-0115 acceptance)', () => {
  it('code, review, planning, project analysis, tests and policy keep byte-identical eligible sets under every OpenAI change', async () => {
    for (const base of [{ QUOKY_CHAT_PROVIDER: 'ollama' }, { QUOKY_CHAT_PROVIDER: 'claude', OLLAMA_MODEL: 'llama3.1' }]) {
      const reference = selectionFixture({ env: base, present: ['codex', 'ollama'] });
      const f = selectionFixture({ env: { ...base, ...OPENAI_ENV }, present: ['codex', 'ollama'] });
      const session = await f.openSession();
      const pinned = async (fixture: typeof f, sessionId?: string) =>
        JSON.stringify(
          await Promise.all(
            CLAUDE_PINNED_CAPABILITIES.map((capability) =>
              fixture.service.preferenceFor(capability, sessionId ? { sessionId, actorId: ACTOR } : {}),
            ),
          ),
        );
      const baseline = await pinned(reference);
      expect(await pinned(f, session.id)).toBe(baseline);
      const changes: Array<() => unknown> = [
        () => f.service.setDefaultChat({ provider: 'openai' }, OPS),
        () => f.service.setDefaultImage('openai', OPS),
        () => f.service.setSessionChat(scope(session), { provider: 'openai', model: 'gpt-4o' }, OWNER_CHAT),
        () => f.service.setSessionImage(scope(session), 'openai', OWNER_CHAT),
        () => f.service.setSessionChat(scope(session), { provider: 'openai' }, OWNER_CHAT),
        () => f.service.resetSession(scope(session), 'all', OWNER_CHAT),
        () => f.service.setDefaultChat(null, OPS),
      ];
      for (const change of changes) {
        await change();
        expect(await pinned(f, session.id), JSON.stringify(base)).toBe(baseline);
        expect(await pinned(f), JSON.stringify(base)).toBe(baseline);
        for (const capability of CLAUDE_PINNED_CAPABILITIES) {
          const chosen = await f.router.select(capability, scope(session)).catch(() => null);
          expect(chosen?.id.startsWith('openai') ?? false, capability).toBe(false);
        }
      }
    }
  });
});

describe('routing corpus with nothing selected (ADR-0115 acceptance)', () => {
  it('for every capability and installation, a configured-but-unselected OpenAI changes no routing decision', async () => {
    const installs = [
      {},
      { QUOKY_CHAT_PROVIDER: 'claude' },
      { QUOKY_CHAT_PROVIDER: 'codex' },
      { QUOKY_CHAT_PROVIDER: 'ollama', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'ollama', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
      { QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' },
      { QUOKY_OLLAMA_ENABLED: 'false', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'codex' },
    ];
    const corpus = async (f: ReturnType<typeof selectionFixture>) => {
      const rows: string[] = [];
      for (const capability of Object.values(Capability)) {
        const preference = await f.service.preferenceFor(capability, {});
        const chosen = await f.router.select(capability).then((p) => p.id, (err) => (err instanceof NoProviderAvailableError ? 'none' : 'error'));
        rows.push(`${capability}:${JSON.stringify(preference)}:${chosen}`);
      }
      rows.push(JSON.stringify(await f.service.imageLocalities({})));
      return rows;
    };
    for (const install of installs) {
      const before = await corpus(selectionFixture({ env: install, present: ['codex', 'ollama'] }));
      const after = await corpus(selectionFixture({ env: { ...install, ...OPENAI_ENV }, present: ['codex', 'ollama'] }));
      expect(after, JSON.stringify(install)).toEqual(before);
    }
  });
});

describe('image locality fence (ADR-0115 D5)', () => {
  it('REMOTE opens for the OpenAI image option only while it is the effective image choice', async () => {
    const f = selectionFixture({
      env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'ollama', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b', ...OPENAI_ENV },
    });
    const session = await f.openSession();
    const ctx = scope(session);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, ctx)).id).toBe('ollama-vision-cli');
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'openai-vision-api')).toBe(false);

    await f.service.setSessionImage(ctx, 'openai', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL', 'REMOTE']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, ctx)).id).toBe('openai-vision-api');
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'openai-vision-api')).toBe(true);
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'ollama-vision-cli')).toBe(false);
    // The chat instance never serves images, whatever the selection.
    expect(f.catalog.openai?.capabilities.some((c) => c.capability === Capability.IMAGE_UNDERSTANDING)).toBe(false);
    // Another conversation is unaffected.
    expect(await f.service.imageLocalities({ sessionId: 'other', actorId: ACTOR })).toEqual(['LOCAL']);

    await f.service.setSessionImage(ctx, 'ollama', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL']);
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'openai-vision-api')).toBe(false);

    await f.service.setSessionImage(ctx, 'off', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual({
      allowedLocalities: [],
      switchedOff: { scope: 'SESSION', choices: ['claude', 'ollama', 'openai'], resetRestores: true },
    });
  });

  it('the OpenAI chat selection alone never opens REMOTE for images', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'openai', ...OPENAI_ENV } });
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL']);
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING)).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(f.catalog.openaiVision).toBeInstanceOf(OpenAiApiVisionProvider);
  });
});

describe('owner surfaces: 모델 목록 / 모델 변경 and the /providers page', () => {
  async function say(text: string, f: ReturnType<typeof selectionFixture>, session: Session) {
    const handler = new ModelSelectionTurnHandler({ service: f.service, ownerIds: [TEST_OWNER] });
    const message: InboundMessage = { id: `m-${Math.random()}`, context: { ...session.context, userId: TEST_OWNER }, text, receivedAt: '2026-10-08T00:00:00.000Z' };
    const ctx: TurnHandlerContext = {
      message,
      session: f.rows.get(session.id) ?? session,
      actor: { id: ACTOR } as unknown as Actor,
      now: '2026-10-08T00:00:00.000Z',
      applyAnchor: null,
      resolveActiveWorkspace: async () => null,
    };
    return replyText(await handler.handle(ctx));
  }

  it('lists the OpenAI models and image option, switches this conversation, and names OpenAI as the egress', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...OPENAI_ENV } });
    const session = await f.openSession();
    const list = await say('모델 목록', f, session);
    expect(list).toContain('openai:gpt-4.1-mini · 준비됨 · 클라우드(OpenAI)');
    // Another allow-listed model was never probed: its readiness is unknown, never borrowed (CA P3-5).
    expect(list).toMatch(/openai:gpt-4o · 클라우드\(OpenAI\)/u);
    expect(list).toContain('이미지 openai');
    const set = await say('모델 변경: openai:gpt-4o', f, session);
    expect(set).toContain('openai:gpt-4o로 바꿨어요');
    expect(set).toContain('대화 내용이 OpenAI로 전송돼요');
    expect(await say('모델 상태', f, session)).toContain('클라우드(OpenAI로 전송)');
    expect(await say('모델 변경: openai:o3', f, session)).toContain('OpenAI 모델은');
    expect(await say('이미지 모델 변경: openai', f, session)).toContain('이미지가 OpenAI로 전송돼요');
    expect(JSON.stringify([...f.rows.values()])).not.toContain(FAKE_KEY);
  });

  it('the operations page offers the OpenAI options with the OpenAI egress warning; the notice names OpenAI', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...OPENAI_ENV } });
    const ops = new OpsProviderSelectionActions({
      service: f.service,
      owner: async () => ({ status: 'RESOLVED', actorId: ACTOR }),
      clock: () => '2026-10-08T00:00:00.000Z',
      logger: { info: () => undefined, warn: () => undefined },
    });
    const page = await ops.page();
    if (page.status !== 'OK') throw new Error('refused');
    expect(page.chat.options.find((o) => o.subject === 'chat:openai:gpt-4.1-mini')).toMatchObject({ egress: '클라우드 (OpenAI로 전송)' });
    expect(page.image.options.find((o) => o.subject === 'image:openai')).toMatchObject({ warning: OPS_CODEX_IMAGE_WARNING });
    expect(await ops.setDefault('chat:openai:gpt-4o')).toMatchObject({ ok: true, code: 'DEFAULT_SET' });
    expect(f.service.globalChat().label).toBe('openai:gpt-4o');
    expect(await ops.setDefault('chat:openai:o3')).toMatchObject({ ok: false, code: 'INVALID_OPTION' });
    expect(providerDefaultNoticeText('image', 'openai', false)).toContain('OpenAI로 전송돼요');
    expect(JSON.stringify(page)).not.toContain(FAKE_KEY);
  });

  it('no selection log line, status or option list ever carries the key', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'openai', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'openai', ...OPENAI_ENV } });
    const session = await f.openSession();
    await f.service.setSessionChat(scope(session), { provider: 'openai', model: 'gpt-5' }, OWNER_CHAT);
    f.service.setDefaultImage('openai', OPS);
    const surfaces = JSON.stringify([f.logs, await f.service.status(scope(session)), await f.service.options(scope(session))]);
    expect(surfaces).not.toContain(FAKE_KEY);
    expect(surfaces).toContain('openai:gpt-5');
  });
});

describe('startup readiness (CA P2-2, option a): a configured but unselected HTTP provider makes no call', () => {
  const realProbes = (extra: Record<string, string>) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ id: 'gpt-4.1-mini', object: 'model' }), { status: 200 });
    }) as typeof fetch);
    // Only the OpenAI instances keep their real probe (over the fake fetch); the CLI providers are stubbed (no spawn).
    const f = selectionFixture({ env: { ...OPENAI_ENV, ...extra }, unstubbed: (p) => p.id.startsWith('openai') });
    const lines: Array<{ message: string; fields?: unknown }> = [];
    const log = {
      info: (message: string, fields?: unknown) => lines.push({ message, fields }),
      warn: (message: string, fields?: unknown) => lines.push({ message, fields }),
      error: () => undefined,
      debug: () => undefined,
    };
    const run = () =>
      reportProviderReadiness(f.manager, log as never, {
        eligible: (capability, provider) => f.service.isEligible(capability, {}, provider.id),
      });
    return { calls, run, lines };
  };

  it('key set and QUOKY_CHAT_PROVIDER=claude: zero fetch calls; the OpenAI instances are reported as not probed', async () => {
    const { calls, run, lines } = realProbes({ QUOKY_CHAT_PROVIDER: 'claude' });
    const report = await run();
    expect(calls).toEqual([]);
    // Every REMOTE provider outside the effective selection is skipped (the OpenAI instances and, here, the unselected
    // Claude vision provider); the effective chat provider and Claude are probed.
    expect(report.notProbed).toEqual(expect.arrayContaining(['openai-api', 'openai-vision-api']));
    expect(report.notProbed).not.toContain('claude-cli');
    expect(report.ready).toContain('claude-cli');
    expect(report.generalChatReady).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(FAKE_KEY);
  });

  it('selected for chat and images: both instances are probed with ONE model-get call', async () => {
    const { calls, run } = realProbes({ QUOKY_CHAT_PROVIDER: 'openai', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'openai' });
    const report = await run();
    expect(calls).toEqual(['https://api.openai.com/v1/models/gpt-4.1-mini']);
    expect(report.ready).toEqual(expect.arrayContaining(['openai-api', 'openai-vision-api']));
    expect(report.notProbed.some((id) => id.startsWith('openai'))).toBe(false);
  });

  it('generalChatReady counts only eligible chat providers', async () => {
    const { run } = realProbes({ QUOKY_CHAT_PROVIDER: 'claude' });
    const report = await run();
    expect(report.generalChatReady).toBe(true);
    const lonely = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...OPENAI_ENV } });
    lonely.ready.set('claude-cli', false);
    lonely.ready.set('openai-api', true);
    const noChat = await reportProviderReadiness(lonely.manager, { info: () => undefined, warn: () => undefined } as never, {
      eligible: (capability, provider) => lonely.service.isEligible(capability, {}, provider.id),
    });
    // openai-api is ready but not the effective chat choice, so chat is NOT counted as served.
    expect(noChat.generalChatReady).toBe(false);
  });
});

describe('composition reply hygiene', () => {
  it('applies the provider-neutral chat hygiene to GENERAL_CHAT and terminal framing to every capability', () => {
    const envelope = JSON.stringify({ role: 'assistant', provenance: 'x', epistemicStatus: 'y', content: 'unused' });
    expect(openAiReplyHygiene('plain \u001b[1mbold\u001b[0m', { capability: Capability.SUMMARIZATION, prompt: 'p' })).toBe('plain bold');
    expect(openAiReplyHygiene('hello', { capability: Capability.GENERAL_CHAT, prompt: 'p' })).toBe('hello');
    // An echoed internal metadata envelope is reduced to its content — for GENERAL_CHAT only.
    const internal = JSON.stringify({ provenance: 'ASSISTANT', epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE', content: '안녕하세요' });
    expect(stripInternalMetadataEnvelope(internal)).toBe('안녕하세요');
    expect(openAiReplyHygiene(internal, { capability: Capability.GENERAL_CHAT, prompt: 'p' })).toBe('안녕하세요');
    expect(openAiReplyHygiene(internal, { capability: Capability.SUMMARIZATION, prompt: 'p' })).toBe(internal);
    // Literal "\n" escapes (two or more, no real newline) become line breaks — for GENERAL_CHAT only.
    const escaped = 'one\\ntwo\\nthree';
    expect(openAiReplyHygiene(escaped, { capability: Capability.GENERAL_CHAT, prompt: 'p' })).toBe('one\ntwo\nthree');
    expect(openAiReplyHygiene(escaped, { capability: Capability.SUMMARIZATION, prompt: 'p' })).toBe(escaped);
    // A non-internal envelope is left alone.
    expect(openAiReplyHygiene(envelope, { capability: Capability.GENERAL_CHAT, prompt: 'p' })).toBe(envelope);
  });
});

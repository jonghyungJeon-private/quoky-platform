import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capability, NoProviderAvailableError } from '@quoky/core';
import type { Actor, InboundMessage, Session, TurnHandlerContext } from '@quoky/core';
import { GeminiApiProvider, GeminiApiVisionProvider } from '@quoky/ai-gemini-api';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { describeStartupFailure, reportProviderReadiness } from '../bootstrap-preflight';
import { composeChatProviders } from '../chat-provider-composition';
import { QuokyConfigErrorCode, loadConfig } from '../config';
import { geminiReplyHygiene } from '../gemini-provider-composition';
import { describeImageUnderstandingSelection } from '../image-understanding-provider';
import { openAiReplyHygiene } from '../openai-provider-composition';
import { OPS_GEMINI_IMAGE_WARNING, OpsProviderSelectionActions, providerDefaultNoticeText } from '../ops-ui/actions/provider-selection-actions';
import { ModelSelectionTurnHandler } from './model-command-turn-handler';
import { CHAT_TIER_CAPABILITIES, CLAUDE_PINNED_CAPABILITIES } from './selection-choices';
import { TEST_OWNER, replyText, selectionFixture } from './test-support';

/**
 * ADR-0115 D4 (PRV-2): the Gemini API option in the owner's runtime switch — configuration and startup errors,
 * registration, the chat-tier-only eligibility, the image locality fence, the ADR-0092 amendment D4 invariant extended
 * to the new provider, the routing corpus with nothing selected, and key redaction. Every provider's probe and
 * execution is stubbed by the fixture; the platform `fetch` is replaced by a fake that fails the test if anything
 * reaches it unexpectedly. No test calls the real API. The fake key is assembled from pieces (no token-shaped literal).
 */

const FAKE_KEY = ['AI', 'za', 'K'.repeat(11), '7x'.repeat(12)].join('');
const MODEL = 'gemini-3.5-flash-lite';
const GEMINI_ENV = { QUOKY_GEMINI_API_KEY: FAKE_KEY, QUOKY_GEMINI_MODEL: MODEL } as const;
const OPENAI_ENV = { QUOKY_OPENAI_API_KEY: ['sk', 'quokyapp', 'K'.repeat(10) + '7x'.repeat(9)].join('-'), QUOKY_OPENAI_MODEL: 'gpt-4.1-mini' } as const;
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
  it('neither variable set → no Gemini provider (blank counts as unset)', () => {
    expect(loadConfig(env()).ai.gemini).toBeUndefined();
    expect(loadConfig(env({ QUOKY_GEMINI_API_KEY: '', QUOKY_GEMINI_MODEL: '  ' })).ai.gemini).toBeUndefined();
  });

  it('both set → the key (in a redacting holder) and the allow-listed model', () => {
    const gemini = loadConfig(env(GEMINI_ENV)).ai.gemini;
    expect(gemini?.model).toBe(MODEL);
    expect(gemini?.apiKey.reveal()).toBe(FAKE_KEY);
  });

  it('inspecting or serialising the whole configuration never shows the key', () => {
    const config = loadConfig(env({ ...GEMINI_ENV, QUOKY_CHAT_PROVIDER: 'gemini', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'gemini' }));
    const views = [
      inspect(config, { depth: 10 }),
      inspect(config, { depth: 10, showHidden: true }),
      JSON.stringify(config),
      JSON.stringify({ ...config.ai.gemini }),
      String(config.ai.gemini?.apiKey),
    ];
    for (const view of views) expect(view).not.toContain(FAKE_KEY);
    expect(inspect(config, { depth: 10 })).toContain('GeminiApiKey([REDACTED])');
    expect(JSON.stringify(config)).toContain('"apiKey":"[REDACTED]"');
  });

  it.each([
    [{ QUOKY_GEMINI_API_KEY: `${FAKE_KEY}"`, QUOKY_GEMINI_MODEL: MODEL }, QuokyConfigErrorCode.GEMINI_API_KEY_INVALID],
    [{ QUOKY_GEMINI_API_KEY: `key=${FAKE_KEY}`, QUOKY_GEMINI_MODEL: MODEL }, QuokyConfigErrorCode.GEMINI_API_KEY_INVALID],
    [{ QUOKY_GEMINI_API_KEY: FAKE_KEY.slice(0, 30), QUOKY_GEMINI_MODEL: MODEL }, QuokyConfigErrorCode.GEMINI_API_KEY_INVALID],
    [{ QUOKY_GEMINI_API_KEY: FAKE_KEY, QUOKY_GEMINI_MODEL: 'gemini-2.0-flash' }, QuokyConfigErrorCode.GEMINI_MODEL_INVALID],
    [{ QUOKY_GEMINI_API_KEY: FAKE_KEY, QUOKY_GEMINI_MODEL: 'Gemini-3.5-Flash' }, QuokyConfigErrorCode.GEMINI_MODEL_INVALID],
    [{ QUOKY_GEMINI_API_KEY: FAKE_KEY, QUOKY_GEMINI_MODEL: `models/${MODEL}` }, QuokyConfigErrorCode.GEMINI_MODEL_INVALID],
    [{ QUOKY_GEMINI_API_KEY: FAKE_KEY }, QuokyConfigErrorCode.GEMINI_MODEL_MISSING],
    [{ QUOKY_GEMINI_MODEL: MODEL }, QuokyConfigErrorCode.GEMINI_API_KEY_MISSING],
    [{ QUOKY_CHAT_PROVIDER: 'gemini' }, QuokyConfigErrorCode.GEMINI_API_KEY_MISSING],
    [{ QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'gemini' }, QuokyConfigErrorCode.GEMINI_API_KEY_MISSING],
  ])('%j → %s', (vars, code) => {
    const err = thrown(() => loadConfig(env(vars)));
    expect((err as { code?: string }).code).toBe(code);
    expect(err.message).toBe(code);
    const report = describeStartupFailure(err);
    expect(report.hint).toBeDefined();
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
    expect(String(err.stack)).not.toContain(FAKE_KEY);
  });

  it('`gemini` is accepted by both selectors once configured; the image selection is REMOTE', () => {
    const config = loadConfig(env({ ...GEMINI_ENV, QUOKY_CHAT_PROVIDER: 'gemini', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'gemini' }));
    expect(config.ai.chat).toMatchObject({ provider: 'gemini', source: 'QUOKY_CHAT_PROVIDER' });
    expect(config.imageUnderstanding).toEqual({ provider: 'gemini' });
    expect(describeImageUnderstandingSelection(config.imageUnderstanding)).toEqual({ selection: 'gemini', locality: 'REMOTE' });
  });

  it('the OpenAI and Gemini APIs configure independently (a malformed OpenAI key never reads as a Gemini one)', () => {
    const both = loadConfig(env({ ...GEMINI_ENV, ...OPENAI_ENV }));
    expect(both.ai.gemini?.model).toBe(MODEL);
    expect(both.ai.openai?.model).toBe('gpt-4.1-mini');
    expect(thrown(() => loadConfig(env({ QUOKY_GEMINI_API_KEY: OPENAI_ENV.QUOKY_OPENAI_API_KEY, QUOKY_GEMINI_MODEL: MODEL }))).message).toBe(
      QuokyConfigErrorCode.GEMINI_API_KEY_INVALID,
    );
  });
});

describe('registration (ADR-0115 D3)', () => {
  it('registers the chat and image instances only when configured; otherwise the provider list is unchanged', () => {
    const without = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex', 'ollama'] });
    const withGemini = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...GEMINI_ENV }, present: ['codex', 'ollama'] });
    const ids = (f: typeof without) => f.catalog.providers.map((p) => p.id);
    expect(ids(without).some((id) => id.startsWith('gemini'))).toBe(false);
    expect(ids(withGemini)).toEqual([
      ...ids(without).filter((id) => !id.includes('vision')),
      'gemini-api',
      ...ids(without).filter((id) => id.includes('vision')),
      'gemini-vision-api',
    ]);
    expect(withGemini.catalog.gemini?.executionLocality).toBe('REMOTE');
    expect(withGemini.catalog.geminiVision?.executionLocality).toBe('REMOTE');
    expect(networkCalls).toEqual([]);
  });

  it('the composition builds real adapters with the reply hygiene; construction makes no network call', () => {
    const config = loadConfig(env({ ...GEMINI_ENV, ...OPENAI_ENV, QUOKY_CHAT_PROVIDER: 'claude' }));
    const logs: unknown[] = [];
    const chat = composeChatProviders(config.ai, { info: (...a) => logs.push(a), warn: (...a) => logs.push(a) });
    expect(chat.gemini).toBeInstanceOf(GeminiApiProvider);
    expect(chat.providers.map((p) => p.id)).toEqual(['claude-cli', 'openai-api', 'gemini-api']);
    expect(JSON.stringify(logs)).not.toContain(FAKE_KEY);
    expect(geminiReplyHygiene).toBe(openAiReplyHygiene);
    expect(networkCalls).toEqual([]);
  });
});

describe('eligibility: the Gemini option answers only while it is the effective choice', () => {
  it('configured but not selected: no capability ever lists it; the chat tier stays on the configured choice', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude', ...GEMINI_ENV } });
    for (const capability of Object.values(Capability)) {
      const preference = await f.service.preferenceFor(capability, {});
      expect(preference?.eligible ?? [], capability).not.toContain('gemini-api');
      expect(preference?.eligible ?? [], capability).not.toContain('gemini-vision-api');
    }
    expect((await f.router.select(Capability.GENERAL_CHAT)).id).toBe('claude-cli');
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING)).id).toBe('claude-vision-cli');
  });

  it('selected for chat: the chat tier routes to it; code, review, planning, tests and policy stay on Claude', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'gemini', ...GEMINI_ENV } });
    for (const capability of CHAT_TIER_CAPABILITIES) expect((await f.router.select(capability)).id, capability).toBe('gemini-api');
    for (const capability of CLAUDE_PINNED_CAPABILITIES) expect((await f.router.select(capability)).id, capability).toBe('claude-cli');
    expect(await f.service.effectiveChat()).toMatchObject({ label: `gemini:${MODEL}`, source: 'env' });
  });

  it('a not-ready Gemini choice falls back to Claude at selection time, and status says so', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'gemini', ...GEMINI_ENV } });
    f.ready.set('gemini-api', false);
    expect((await f.router.select(Capability.GENERAL_CHAT)).id).toBe('claude-cli');
    expect((await f.service.status()).chat).toMatchObject({ label: `gemini:${MODEL}`, ready: false, fallbackLabel: 'claude:sonnet' });
  });

  it('another allow-listed model is an on-demand chat-tier-only instance; a model off the list is refused', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...GEMINI_ENV } });
    const session = await f.openSession();
    const validated = await f.service.validateChatToken('gemini:gemini-3.8-flash');
    expect(validated).toEqual({ ok: true, choice: { provider: 'gemini', model: 'gemini-3.8-flash' } });
    if (!validated.ok) throw new Error('unreachable');
    await f.service.setSessionChat(scope(session), validated.choice, OWNER_CHAT);
    const chosen = await f.router.select(Capability.SUMMARIZATION, scope(session));
    expect(chosen.id).toBe('gemini-api:gemini-3.8-flash');
    expect(chosen.executionLocality).toBe('REMOTE');
    expect(chosen.capabilities.map((c) => c.capability).sort()).toEqual([...CHAT_TIER_CAPABILITIES].sort());
    expect((await f.router.select(Capability.CODE_REVIEW, scope(session))).id).toBe('claude-cli');
    expect(await f.service.validateChatToken('gemini:gemini-2.0-flash')).toEqual({ ok: false, refusal: 'GEMINI_MODEL_NOT_ALLOWED' });
    // The configured model folds into the default instance.
    expect(await f.service.validateChatToken(`gemini:${MODEL}`)).toEqual({ ok: true, choice: { provider: 'gemini' } });
  });

  it('not configured: the option cannot be chosen, and a stale persisted or session choice is skipped', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    expect(await f.service.validateChatToken('gemini')).toEqual({ ok: false, refusal: 'PROVIDER_NOT_ON_HOST' });
    expect(f.service.validateImageToken('gemini')).toEqual({ ok: false, refusal: 'IMAGE_OPTION_UNAVAILABLE' });
    f.store.save({ chat: { provider: 'gemini' }, image: 'gemini', updatedAt: '2026-10-08T00:00:00.000Z' });
    expect(await f.service.effectiveChat()).toMatchObject({ label: 'claude:sonnet', ignored: ['persisted'] });
    expect(await f.service.effectiveImage()).toMatchObject({ choice: 'off', ignored: ['persisted'] });
  });

  it('with OpenAI and Gemini both configured, each answers only while it is the effective choice', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'openai', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'gemini', ...OPENAI_ENV, ...GEMINI_ENV } });
    expect((await f.router.select(Capability.GENERAL_CHAT)).id).toBe('openai-api');
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING)).id).toBe('gemini-vision-api');
    expect(f.service.isEligible(Capability.GENERAL_CHAT, {}, 'gemini-api')).toBe(false);
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, {}, 'openai-vision-api')).toBe(false);
  });
});

describe('the ADR-0092 amendment D4 invariant extended to the Gemini provider (ADR-0115 acceptance)', () => {
  it('code, review, planning, project analysis, tests and policy keep byte-identical eligible sets under every Gemini change', async () => {
    for (const base of [{ QUOKY_CHAT_PROVIDER: 'ollama' }, { QUOKY_CHAT_PROVIDER: 'claude', OLLAMA_MODEL: 'llama3.1' }, { QUOKY_CHAT_PROVIDER: 'gemini' }]) {
      // The reference is the installation without any HTTP provider; `gemini` as the installation's own choice is
      // compared against the Claude-selected reference (the pinned set never depends on the chat selection).
      const referenceEnv = base.QUOKY_CHAT_PROVIDER === 'gemini' ? { QUOKY_CHAT_PROVIDER: 'claude' } : base;
      const reference = selectionFixture({ env: referenceEnv, present: ['codex', 'ollama'] });
      const f = selectionFixture({ env: { ...base, ...GEMINI_ENV, ...OPENAI_ENV }, present: ['codex', 'ollama'] });
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
        () => f.service.setDefaultChat({ provider: 'gemini' }, OPS),
        () => f.service.setDefaultImage('gemini', OPS),
        () => f.service.setSessionChat(scope(session), { provider: 'gemini', model: 'gemini-3.8-flash' }, OWNER_CHAT),
        () => f.service.setSessionImage(scope(session), 'gemini', OWNER_CHAT),
        () => f.service.setSessionChat(scope(session), { provider: 'gemini' }, OWNER_CHAT),
        () => f.service.setSessionChat(scope(session), { provider: 'openai' }, OWNER_CHAT),
        () => f.service.resetSession(scope(session), 'all', OWNER_CHAT),
        () => f.service.setDefaultChat(null, OPS),
        () => f.service.setDefaultImage(null, OPS),
      ];
      for (const change of changes) {
        await change();
        expect(await pinned(f, session.id), JSON.stringify(base)).toBe(baseline);
        expect(await pinned(f), JSON.stringify(base)).toBe(baseline);
        for (const capability of CLAUDE_PINNED_CAPABILITIES) {
          const chosen = await f.router.select(capability, scope(session)).catch(() => null);
          expect(chosen?.id.startsWith('gemini') ?? false, capability).toBe(false);
          expect(chosen?.id.startsWith('openai') ?? false, capability).toBe(false);
        }
      }
    }
  });
});

describe('routing corpus with nothing selected (ADR-0115 acceptance)', () => {
  it('for every capability and installation, a configured-but-unselected Gemini changes no routing decision', async () => {
    const installs = [
      {},
      { QUOKY_CHAT_PROVIDER: 'claude' },
      { QUOKY_CHAT_PROVIDER: 'codex' },
      { QUOKY_CHAT_PROVIDER: 'ollama', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'ollama', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
      { QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' },
      { QUOKY_OLLAMA_ENABLED: 'false', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'codex' },
      { QUOKY_CHAT_PROVIDER: 'openai', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'openai', ...OPENAI_ENV },
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
      const after = await corpus(selectionFixture({ env: { ...install, ...GEMINI_ENV }, present: ['codex', 'ollama'] }));
      expect(after, JSON.stringify(install)).toEqual(before);
    }
  });
});

describe('image locality fence (ADR-0115 D5)', () => {
  it('REMOTE opens for the Gemini image option only while it is the effective image choice', async () => {
    const f = selectionFixture({
      env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'ollama', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b', ...GEMINI_ENV },
    });
    const session = await f.openSession();
    const ctx = scope(session);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, ctx)).id).toBe('ollama-vision-cli');
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'gemini-vision-api')).toBe(false);

    await f.service.setSessionImage(ctx, 'gemini', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL', 'REMOTE']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, ctx)).id).toBe('gemini-vision-api');
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'gemini-vision-api')).toBe(true);
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'ollama-vision-cli')).toBe(false);
    // The chat instance never serves images, whatever the selection.
    expect(f.catalog.gemini?.capabilities.some((c) => c.capability === Capability.IMAGE_UNDERSTANDING)).toBe(false);
    // Another conversation is unaffected.
    expect(await f.service.imageLocalities({ sessionId: 'other', actorId: ACTOR })).toEqual(['LOCAL']);

    await f.service.setSessionImage(ctx, 'ollama', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL']);
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'gemini-vision-api')).toBe(false);

    await f.service.setSessionImage(ctx, 'off', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual({
      allowedLocalities: [],
      switchedOff: { scope: 'SESSION', choices: ['claude', 'ollama', 'gemini'], resetRestores: true },
    });
  });

  it('the Gemini chat selection alone never opens REMOTE for images', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'gemini', ...GEMINI_ENV } });
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL']);
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING)).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(f.catalog.geminiVision).toBeInstanceOf(GeminiApiVisionProvider);
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

  it('lists the Gemini models and image option, switches this conversation, and names Google as the egress', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...GEMINI_ENV } });
    const session = await f.openSession();
    const list = await say('모델 목록', f, session);
    expect(list).toContain(`gemini:${MODEL} · 준비됨 · 클라우드(Google)`);
    // Another allow-listed model was never probed: its readiness is unknown, never borrowed.
    expect(list).toMatch(/gemini:gemini-3\.8-flash · 클라우드\(Google\)/u);
    expect(list).toContain('이미지 gemini');
    const set = await say('모델 변경: gemini:gemini-3.8-flash', f, session);
    expect(set).toContain('gemini:gemini-3.8-flash로 바꿨어요');
    expect(set).toContain('대화 내용이 Google로 전송돼요');
    expect(await say('모델 상태', f, session)).toContain('클라우드(Google로 전송)');
    expect(await say('모델 변경: gemini:gemini-2.0-flash', f, session)).toContain('Gemini 모델은');
    expect(await say('이미지 모델 변경: gemini', f, session)).toContain('이미지가 Google로 전송돼요');
    expect(await say('모델 상태', f, session)).toContain('클라우드(이미지가 Google로 전송돼요)');
    expect(JSON.stringify([...f.rows.values()])).not.toContain(FAKE_KEY);
  });

  it('the operations page offers the Gemini options with the Google egress warning; the notice names Google', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...GEMINI_ENV } });
    const ops = new OpsProviderSelectionActions({
      service: f.service,
      owner: async () => ({ status: 'RESOLVED', actorId: ACTOR }),
      clock: () => '2026-10-08T00:00:00.000Z',
      logger: { info: () => undefined, warn: () => undefined },
    });
    const page = await ops.page();
    if (page.status !== 'OK') throw new Error('refused');
    expect(page.chat.options.find((o) => o.subject === `chat:gemini:${MODEL}`)).toMatchObject({ egress: '클라우드 (Google로 전송)' });
    expect(page.image.options.find((o) => o.subject === 'image:gemini')).toMatchObject({ warning: OPS_GEMINI_IMAGE_WARNING });
    expect(await ops.setDefault('chat:gemini:gemini-3.8-flash')).toMatchObject({ ok: true, code: 'DEFAULT_SET' });
    expect(f.service.globalChat().label).toBe('gemini:gemini-3.8-flash');
    expect(await ops.setDefault('chat:gemini:gemini-2.0-flash')).toMatchObject({ ok: false, code: 'INVALID_OPTION' });
    expect(providerDefaultNoticeText('image', 'gemini', false)).toContain('Google로 전송돼요');
    expect(JSON.stringify(page)).not.toContain(FAKE_KEY);
  });

  it('no selection log line, status or option list ever carries the key', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'gemini', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'gemini', ...GEMINI_ENV } });
    const session = await f.openSession();
    await f.service.setSessionChat(scope(session), { provider: 'gemini', model: 'gemini-3.1-pro-preview' }, OWNER_CHAT);
    f.service.setDefaultImage('gemini', OPS);
    const surfaces = JSON.stringify([f.logs, await f.service.status(scope(session)), await f.service.options(scope(session))]);
    expect(surfaces).not.toContain(FAKE_KEY);
    expect(surfaces).toContain('gemini:gemini-3.1-pro-preview');
  });
});

describe('startup readiness (ADR-0115 implementation note, option a): a configured but unselected Gemini makes no call', () => {
  const realProbes = (extra: Record<string, string>) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ name: `models/${MODEL}`, supportedGenerationMethods: ['generateContent'] }), { status: 200 });
    }) as typeof fetch);
    // Only the Gemini instances keep their real probe (over the fake fetch); the CLI providers are stubbed (no spawn).
    const f = selectionFixture({ env: { ...GEMINI_ENV, ...extra }, unstubbed: (p) => p.id.startsWith('gemini') });
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

  it('key set and QUOKY_CHAT_PROVIDER=claude: zero fetch calls; the Gemini instances are reported as not probed', async () => {
    const { calls, run, lines } = realProbes({ QUOKY_CHAT_PROVIDER: 'claude' });
    const report = await run();
    expect(calls).toEqual([]);
    expect(report.notProbed).toEqual(expect.arrayContaining(['gemini-api', 'gemini-vision-api']));
    expect(report.notProbed).not.toContain('claude-cli');
    expect(report.ready).toContain('claude-cli');
    expect(report.generalChatReady).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(FAKE_KEY);
  });

  it('selected for chat and images: both instances are probed with ONE model-get call (key in the header only)', async () => {
    const { calls, run } = realProbes({ QUOKY_CHAT_PROVIDER: 'gemini', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'gemini' });
    const report = await run();
    expect(calls).toEqual([`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`]);
    expect(report.ready).toEqual(expect.arrayContaining(['gemini-api', 'gemini-vision-api']));
    expect(report.notProbed.some((id) => id.startsWith('gemini'))).toBe(false);
    expect(calls.join('\n')).not.toContain(FAKE_KEY);
  });

  it('generalChatReady counts only eligible chat providers', async () => {
    const lonely = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', ...GEMINI_ENV } });
    lonely.ready.set('claude-cli', false);
    lonely.ready.set('gemini-api', true);
    const noChat = await reportProviderReadiness(lonely.manager, { info: () => undefined, warn: () => undefined } as never, {
      eligible: (capability, provider) => lonely.service.isEligible(capability, {}, provider.id),
    });
    // gemini-api is ready but not the effective chat choice, so chat is NOT counted as served.
    expect(noChat.generalChatReady).toBe(false);
  });
});

describe('execution failure → selection-time fallback through the real router', () => {
  function scripted(extra: Record<string, string>, post: number) {
    let gets = 0;
    const posts: string[] = [];
    vi.stubGlobal('fetch', (async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'GET') {
        gets += 1;
        // The first model-get succeeds; every later one is refused (the key was revoked: Gemini answers 400).
        return gets === 1
          ? new Response(JSON.stringify({ name: `models/${MODEL}` }), { status: 200 })
          : new Response('{}', { status: 400 });
      }
      posts.push(String(input));
      return new Response('{"error":{"message":"busy"}}', { status: post });
    }) as typeof fetch);
    const f = selectionFixture({ env: { ...GEMINI_ENV, ...extra }, unstubbed: (p) => p.id.startsWith('gemini') });
    return { f, gets: () => gets, posts };
  }

  it.each([
    [503, 'UNAVAILABLE'],
    [429, 'UNAVAILABLE'],
    [400, 'EXECUTION_FAILED'],
  ])('chat: GET ok → POST %i → the next selection re-probes and falls back to the ready Claude', async (status, kind) => {
    const { f, gets, posts } = scripted({ QUOKY_CHAT_PROVIDER: 'gemini' }, status);
    const first = await f.router.select(Capability.GENERAL_CHAT);
    expect(first.id).toBe('gemini-api');
    await expect(first.execute({ capability: Capability.GENERAL_CHAT, prompt: 'hi' })).rejects.toMatchObject({ kind });
    expect(posts).toEqual([`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`]);
    const next = await f.router.select(Capability.GENERAL_CHAT);
    expect(next.id).toBe('claude-cli');
    expect(gets()).toBe(2);
  });

  it('vision: GET ok → POST 429 → the next image selection re-probes; with the GET failing nothing is selected', async () => {
    const { f, gets } = scripted({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'gemini' }, 429);
    const dir = mkdtempSync(path.join(tmpdir(), 'quoky-gemini-vision-'));
    try {
      const image = path.join(dir, 'a.png');
      writeFileSync(image, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]));
      const first = await f.router.select(Capability.IMAGE_UNDERSTANDING);
      expect(first.id).toBe('gemini-vision-api');
      await expect(
        first.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p', images: [{ path: image, mimeType: 'image/png' }] }),
      ).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
      await expect(f.router.select(Capability.IMAGE_UNDERSTANDING)).rejects.toBeInstanceOf(NoProviderAvailableError);
      expect(gets()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

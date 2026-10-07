import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Capability, NoProviderAvailableError } from '@quoky/core';
import { selectionFixture } from './test-support';
import { CHAT_TIER_CAPABILITIES, CLAUDE_PINNED_CAPABILITIES } from './selection-choices';
import { SESSION_SELECTION_METADATA_KEY } from './provider-selection-service';
import { ProviderSelectionStore, providerSelectionFileIo } from './selection-store';

/**
 * ADR-0092 amendment + ADR-0111 amendment (runtime switching): the effective selection and its precedence
 * (session → persisted operations-UI default → env → derived default), applied by the REAL `CapabilityRouter` through
 * the `ProviderSelectionPolicy` port, with readiness still deciding availability.
 */

const OWNER_CHAT = { surface: 'chat' as const, actor: 'actor-owner' };
const OPS = { surface: 'ops-ui' as const, actor: 'actor-owner' };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('precedence: session → persisted → env → derived default', () => {
  it('derived default when nothing is set (QUOKY_OLLAMA_ENABLED default → ollama; image off)', async () => {
    const f = selectionFixture();
    expect(await f.service.effectiveChat()).toMatchObject({ label: 'ollama:llama3.1', source: 'default' });
    expect(await f.service.effectiveImage()).toMatchObject({ choice: 'off', source: 'default' });
  });

  it('env beats the derived default; persisted beats env; session beats persisted — per tier', async () => {
    const f = selectionFixture({
      env: { QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' },
      present: ['codex'],
    });
    const session = await f.openSession();
    expect(await f.service.effectiveChat(session.id)).toMatchObject({ label: 'claude:sonnet', source: 'env' });
    expect(await f.service.effectiveImage(session.id)).toMatchObject({ choice: 'claude', source: 'env' });

    f.service.setDefaultChat({ provider: 'codex' }, OPS);
    f.service.setDefaultImage('off', OPS);
    expect(await f.service.effectiveChat(session.id)).toMatchObject({ label: 'codex', source: 'persisted' });
    expect(await f.service.effectiveImage(session.id)).toMatchObject({ choice: 'off', source: 'persisted' });

    await f.service.setSessionChat(session.id, { provider: 'claude', model: 'opus' }, OWNER_CHAT);
    expect(await f.service.effectiveChat(session.id)).toMatchObject({ label: 'claude:opus', source: 'session' });
    // The image override is independent of the chat override.
    expect(await f.service.effectiveImage(session.id)).toMatchObject({ choice: 'off', source: 'persisted' });
    await f.service.setSessionImage(session.id, 'claude', OWNER_CHAT);
    expect(await f.service.effectiveImage(session.id)).toMatchObject({ choice: 'claude', source: 'session' });

    // Another conversation, and a request with no conversation, see the persisted default only.
    const other = await f.openSession();
    expect(await f.service.effectiveChat(other.id)).toMatchObject({ label: 'codex', source: 'persisted' });
    expect(await f.service.effectiveChat()).toMatchObject({ label: 'codex', source: 'persisted' });

    // Resetting the persisted default falls back to env; the session override is untouched.
    f.service.setDefaultChat(null, OPS);
    expect(await f.service.effectiveChat(other.id)).toMatchObject({ label: 'claude:sonnet', source: 'env' });
    expect(await f.service.effectiveChat(session.id)).toMatchObject({ label: 'claude:opus', source: 'session' });
  });

  it('a layer that cannot run on this host is skipped and reported (no Codex registered)', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const session = await f.openSession();
    f.rows.set(session.id, { ...session, metadata: { [SESSION_SELECTION_METADATA_KEY]: { chat: { provider: 'codex' } } } });
    expect(await f.service.effectiveChat(session.id)).toMatchObject({ label: 'claude:sonnet', source: 'env', ignored: ['session'] });
  });

  it('a malformed session entry is ignored; a CLOSED session has no override', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex'] });
    const session = await f.openSession();
    f.rows.set(session.id, { ...session, metadata: { [SESSION_SELECTION_METADATA_KEY]: { chat: { provider: 'gpt' }, image: 'cloud' } } });
    expect(await f.service.effectiveChat(session.id)).toMatchObject({ source: 'env' });
    expect(await f.service.effectiveImage(session.id)).toMatchObject({ source: 'default' });
    await f.service.setSessionChat(session.id, { provider: 'codex' }, OWNER_CHAT);
    expect(await f.service.effectiveChat(session.id)).toMatchObject({ label: 'codex', source: 'session' });
    const live = f.rows.get(session.id);
    if (live === undefined) throw new Error('no session');
    await f.sessions.close(live);
    expect(await f.service.effectiveChat(session.id)).toMatchObject({ source: 'env' });
  });
});

describe('the router applies the selection as data (real CapabilityRouter + ProviderSelectionPolicy)', () => {
  it('chat tier follows the effective selection; Claude keeps code, review, planning, tests and policy-sensitive chat', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex'] });
    const session = await f.openSession();
    for (const capability of CHAT_TIER_CAPABILITIES) {
      expect((await f.router.select(capability, { sessionId: session.id })).id, capability).toBe('claude-cli');
    }
    await f.service.setSessionChat(session.id, { provider: 'codex' }, OWNER_CHAT);
    for (const capability of CHAT_TIER_CAPABILITIES) {
      expect((await f.router.select(capability, { sessionId: session.id })).id, capability).toBe('codex-cli');
      // Another conversation is unaffected.
      expect((await f.router.select(capability, { sessionId: 'other' })).id, capability).toBe('claude-cli');
    }
    for (const capability of CLAUDE_PINNED_CAPABILITIES) {
      expect((await f.router.select(capability, { sessionId: session.id })).id, capability).toBe('claude-cli');
    }
  });

  it('a Claude alias choice runs on a chat-tier-only instance; it never serves pinned capabilities', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const session = await f.openSession();
    await f.service.setSessionChat(session.id, { provider: 'claude', model: 'opus' }, OWNER_CHAT);
    const chosen = await f.router.select(Capability.GENERAL_CHAT, { sessionId: session.id });
    expect(chosen.id).toBe('claude-cli:opus');
    expect(chosen.capabilities.map((c) => c.capability).sort()).toEqual([...CHAT_TIER_CAPABILITIES].sort());
    expect((await f.router.select(Capability.CODE_IMPLEMENTATION, { sessionId: session.id })).id).toBe('claude-cli');
    expect((await f.router.select(Capability.POLICY_SENSITIVE_CHAT, { sessionId: session.id })).id).toBe('claude-cli');
  });

  it('an Ollama model choice adds one on-demand local instance and serves the chat tier only', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['ollama'] });
    const session = await f.openSession();
    const validated = await f.service.validateChatToken('ollama:granite3.3:8b');
    expect(validated).toEqual({ ok: true, choice: { provider: 'ollama', model: 'granite3.3:8b' } });
    if (!validated.ok) throw new Error('unreachable');
    await f.service.setSessionChat(session.id, validated.choice, OWNER_CHAT);
    const chosen = await f.router.select(Capability.SUMMARIZATION, { sessionId: session.id });
    expect(chosen.id).toBe('ollama-cli:granite3.3:8b');
    expect(chosen.executionLocality).toBe('LOCAL');
    expect((await f.router.select(Capability.CODE_IMPLEMENTATION, { sessionId: session.id })).id).toBe('claude-cli');
  });

  it('a chosen provider that is not ready falls back to Claude (selection-time), and status says so truthfully', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'codex' } });
    f.ready.set('codex-cli', false);
    expect((await f.router.select(Capability.GENERAL_CHAT)).id).toBe('claude-cli');
    const status = await f.service.status();
    expect(status.chat).toMatchObject({ label: 'codex', ready: false, fallbackLabel: 'claude:sonnet' });
    f.ready.set('claude-cli', false);
    await expect(f.router.select(Capability.GENERAL_CHAT)).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('pinned capabilities keep the local Ollama code fallback only when the global chat default is Ollama', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'ollama' }, present: ['codex'] });
    f.ready.set('claude-cli', false);
    expect((await f.router.select(Capability.CODE_IMPLEMENTATION)).id).toBe('ollama-cli');
    // A session override never widens pinned work; a global switch to codex removes the Ollama fallback.
    f.service.setDefaultChat({ provider: 'codex' }, OPS);
    await expect(f.router.select(Capability.CODE_IMPLEMENTATION)).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('embedding and other unpinned capabilities get no preference (legacy priority path)', async () => {
    const f = selectionFixture();
    expect(await f.service.preferenceFor(Capability.EMBEDDING, {})).toBeNull();
  });
});

describe('image understanding: eligibility and the Core locality policy follow the effective selection', () => {
  it('REMOTE is allowed only while the effective image choice is claude; switching away stops egress at once', async () => {
    const f = selectionFixture({
      env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
    });
    const session = await f.openSession();
    expect(await f.service.imageLocalities({ sessionId: session.id })).toEqual(['LOCAL', 'REMOTE']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, { sessionId: session.id })).id).toBe('claude-vision-cli');

    await f.service.setSessionImage(session.id, 'ollama', OWNER_CHAT);
    expect(await f.service.imageLocalities({ sessionId: session.id })).toEqual(['LOCAL']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, { sessionId: session.id })).id).toBe('ollama-vision-cli');

    await f.service.setSessionImage(session.id, 'off', OWNER_CHAT);
    expect(await f.service.imageLocalities({ sessionId: session.id })).toEqual(['LOCAL']);
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING, { sessionId: session.id })).rejects.toBeInstanceOf(
      NoProviderAvailableError,
    );

    // The operations-UI default switches every conversation without an override immediately.
    f.service.setDefaultImage('off', OPS);
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL']);
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING, {})).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('with nothing configured the Claude vision provider is registered but never eligible, and REMOTE stays closed', async () => {
    const f = selectionFixture();
    expect(f.catalog.claudeVision?.id).toBe('claude-vision-cli');
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL']);
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING)).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('ollama cannot be chosen for images without a configured local vision model', () => {
    const f = selectionFixture();
    expect(f.service.validateImageToken('ollama')).toEqual({ ok: false, refusal: 'IMAGE_OPTION_UNAVAILABLE' });
    expect(f.service.validateImageToken('gpt')).toEqual({ ok: false, refusal: 'IMAGE_CHOICE_INVALID' });
    expect(f.service.validateImageToken('OFF')).toEqual({ ok: true, choice: 'off' });
  });
});

describe('validation against this host', () => {
  it('refuses unknown providers, non-allow-listed Claude models, Codex models, absent CLIs and unlisted Ollama models', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['ollama'] });
    expect(await f.service.validateChatToken('gpt')).toEqual({ ok: false, refusal: 'UNKNOWN_PROVIDER' });
    expect(await f.service.validateChatToken('claude:claude-3-opus')).toEqual({ ok: false, refusal: 'CLAUDE_MODEL_NOT_ALLOWED' });
    expect(await f.service.validateChatToken('codex:gpt-5')).toEqual({ ok: false, refusal: 'CODEX_MODEL_NOT_ALLOWED' });
    expect(await f.service.validateChatToken('codex')).toEqual({ ok: false, refusal: 'PROVIDER_NOT_ON_HOST' });
    expect(await f.service.validateChatToken('ollama:mistral')).toEqual({ ok: false, refusal: 'OLLAMA_MODEL_NOT_FOUND' });
    expect(await f.service.validateChatToken('ollama:gpt-oss:120b-cloud')).toEqual({ ok: false, refusal: 'MODEL_INVALID' });
    f.inventory = { status: 'UNAVAILABLE' };
    expect(await f.service.validateChatToken('ollama:granite3.3:8b')).toEqual({ ok: false, refusal: 'OLLAMA_UNAVAILABLE' });
    expect(await f.service.validateChatToken('CLAUDE:Opus')).toEqual({ ok: true, choice: { provider: 'claude', model: 'opus' } });
    // The configured default model folds into "the default".
    expect(await f.service.validateChatToken('claude:sonnet')).toEqual({ ok: true, choice: { provider: 'claude' } });
  });

  it('a full configured QUOKY_CLAUDE_MODEL stays selectable by its own label', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', QUOKY_CLAUDE_MODEL: 'claude-sonnet-4-5' } });
    expect(await f.service.validateChatToken('claude:claude-sonnet-4-5')).toEqual({ ok: true, choice: { provider: 'claude' } });
    const options = await f.service.options();
    expect(options.filter((o) => o.tier === 'chat').map((o) => o.token)).toEqual([
      'claude:claude-sonnet-4-5',
      'claude:sonnet',
      'claude:opus',
      'claude:haiku',
    ]);
  });
});

describe('options and status', () => {
  it('lists Claude aliases, Codex when registered, local Ollama models, then image options, with readiness and egress', async () => {
    const f = selectionFixture({
      env: { QUOKY_CHAT_PROVIDER: 'claude', OLLAMA_MODEL: 'llama3.1', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' },
      present: ['codex', 'ollama'],
    });
    f.ready.set('codex-cli', false);
    const options = await f.service.options();
    expect(options.map((o) => [o.tier, o.token, o.ready, o.egress, o.current])).toEqual([
      ['chat', 'claude:sonnet', true, 'ANTHROPIC', true],
      ['chat', 'claude:opus', true, 'ANTHROPIC', false],
      ['chat', 'claude:haiku', true, 'ANTHROPIC', false],
      ['chat', 'codex', false, 'OPENAI', false],
      ['chat', 'ollama:llama3.1', true, 'LOCAL', false],
      ['chat', 'ollama:granite3.3:8b', true, 'LOCAL', false],
      ['image', 'claude', true, 'ANTHROPIC', true],
      ['image', 'off', undefined, 'NONE', false],
    ]);
    // Listing never instantiated anything on demand and never executed a provider.
    expect(f.catalog.providers.map((p) => p.id)).toEqual(['claude-cli', 'ollama-cli', 'codex-cli', 'claude-vision-cli']);
    expect(f.executed).toEqual([]);
  });

  it('counts open conversations that carry their own override', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const a = await f.openSession();
    await f.openSession();
    expect(await f.service.sessionOverrideCount()).toBe(0);
    await f.service.setSessionImage(a.id, 'off', OWNER_CHAT);
    expect(await f.service.sessionOverrideCount()).toBe(1);
  });
});

describe('audit and fail-safe', () => {
  it('logs every selection change with surface, actor, scope, tier and the label (no content)', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex'] });
    const session = await f.openSession();
    await f.service.setSessionChat(session.id, { provider: 'codex' }, OWNER_CHAT);
    f.service.setDefaultImage('off', OPS);
    await f.service.resetSession(session.id, 'all', OWNER_CHAT);
    const changes = f.logs.filter((l) => l.message === 'provider.selection.changed').map((l) => l.fields);
    expect(changes).toEqual([
      { surface: 'chat', actor: 'actor-owner', scope: 'session', tier: 'chat', selection: 'codex', sessionId: session.id },
      { surface: 'ops-ui', actor: 'actor-owner', scope: 'default', tier: 'image', selection: 'off' },
      { surface: 'chat', actor: 'actor-owner', scope: 'session', tier: 'chat+image', selection: 'reset', sessionId: session.id },
    ]);
  });

  it('when the session store fails, the chat tier and pinned work go to Claude and images go nowhere', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'codex', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' } });
    (f.service as unknown as { deps: { sessions: () => unknown } }).deps.sessions = () => ({
      get: async () => {
        throw new Error('db down');
      },
    });
    expect(await f.service.preferenceFor(Capability.GENERAL_CHAT, { sessionId: 's' })).toEqual({ eligible: ['claude-cli'], order: 'listed' });
    expect(await f.service.preferenceFor(Capability.IMAGE_UNDERSTANDING, { sessionId: 's' })).toEqual({ eligible: [], order: 'listed' });
    expect(await f.service.imageLocalities({ sessionId: 's' })).toEqual(['LOCAL']);
  });
});

describe('persistence round trip (private file beside the DB)', () => {
  it('a default set in one process is the effective selection of the next; a corrupt file falls back to env', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'quoky-selection-'));
    const file = path.join(dir, 'ops', 'provider-selection.json');
    const env = { QUOKY_CHAT_PROVIDER: 'claude' };
    const first = selectionFixture({ env, present: ['codex'], io: providerSelectionFileIo(file) });
    first.service.setDefaultChat({ provider: 'codex' }, OPS);
    first.service.setDefaultImage('off', OPS);

    const persisted = new ProviderSelectionStore(providerSelectionFileIo(file), { warn: () => undefined }).get();
    const second = selectionFixture({ env, present: ['codex'], io: providerSelectionFileIo(file), ...(persisted.chat ? { persistedChat: persisted.chat } : {}) });
    expect(await second.service.effectiveChat()).toMatchObject({ label: 'codex', source: 'persisted' });
    expect(await second.service.effectiveImage()).toMatchObject({ choice: 'off', source: 'persisted' });
  });
});

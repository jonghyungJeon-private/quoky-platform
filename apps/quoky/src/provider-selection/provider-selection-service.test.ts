import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiProviderManager, Capability, CapabilityRouter, NoProviderAvailableError } from '@quoky/core';
import type { AiProvider } from '@quoky/core';
import { selectionFixture } from './test-support';
import { CHAT_TIER_CAPABILITIES, CLAUDE_PINNED_CAPABILITIES } from './selection-choices';
import { SESSION_SELECTION_METADATA_KEY } from './provider-selection-service';
import { ProviderSelectionStore, providerSelectionFileIo } from './selection-store';

const ACTOR = 'actor-owner';
const scope = (session: { readonly id: string }) => ({ sessionId: session.id, actorId: ACTOR });

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
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ label: 'claude:sonnet', source: 'env' });
    expect(await f.service.effectiveImage(scope(session))).toMatchObject({ choice: 'claude', source: 'env' });

    f.service.setDefaultChat({ provider: 'codex' }, OPS);
    f.service.setDefaultImage('off', OPS);
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ label: 'codex', source: 'persisted' });
    expect(await f.service.effectiveImage(scope(session))).toMatchObject({ choice: 'off', source: 'persisted' });

    await f.service.setSessionChat(scope(session), { provider: 'claude', model: 'opus' }, OWNER_CHAT);
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ label: 'claude:opus', source: 'session' });
    // The image override is independent of the chat override.
    expect(await f.service.effectiveImage(scope(session))).toMatchObject({ choice: 'off', source: 'persisted' });
    await f.service.setSessionImage(scope(session), 'claude', OWNER_CHAT);
    expect(await f.service.effectiveImage(scope(session))).toMatchObject({ choice: 'claude', source: 'session' });

    // Another conversation, and a request with no conversation, see the persisted default only.
    const other = await f.openSession();
    expect(await f.service.effectiveChat(scope(other))).toMatchObject({ label: 'codex', source: 'persisted' });
    expect(await f.service.effectiveChat()).toMatchObject({ label: 'codex', source: 'persisted' });

    // Resetting the persisted default falls back to env; the session override is untouched.
    f.service.setDefaultChat(null, OPS);
    expect(await f.service.effectiveChat(scope(other))).toMatchObject({ label: 'claude:sonnet', source: 'env' });
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ label: 'claude:opus', source: 'session' });
  });

  it('a layer that cannot run on this host is skipped and reported (no Codex registered)', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const session = await f.openSession();
    f.rows.set(session.id, { ...session, metadata: { [SESSION_SELECTION_METADATA_KEY]: { byActor: { [ACTOR]: { chat: { provider: 'codex' } } } } } });
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ label: 'claude:sonnet', source: 'env', ignored: ['session'] });
  });

  it('a malformed session entry is ignored; a CLOSED session has no override', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex'] });
    const session = await f.openSession();
    f.rows.set(session.id, { ...session, metadata: { [SESSION_SELECTION_METADATA_KEY]: { byActor: { [ACTOR]: { chat: { provider: 'gpt' }, image: 'cloud' } } } } });
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ source: 'env' });
    expect(await f.service.effectiveImage(scope(session))).toMatchObject({ source: 'default' });
    await f.service.setSessionChat(scope(session), { provider: 'codex' }, OWNER_CHAT);
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ label: 'codex', source: 'session' });
    const live = f.rows.get(session.id);
    if (live === undefined) throw new Error('no session');
    await f.sessions.close(live);
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ source: 'env' });
  });
});

describe('session overrides are keyed by (Session, Actor)', () => {
  it('two owner Actors in one shared channel Session never read or overwrite each other\'s override', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' }, present: ['codex'] });
    const shared = await f.openSession();
    const a = { sessionId: shared.id, actorId: 'actor-a' };
    const b = { sessionId: shared.id, actorId: 'actor-b' };
    await f.service.setSessionChat(a, { provider: 'codex' }, { surface: 'chat', actor: 'actor-a' });
    // B inherits nothing from A.
    expect(await f.service.effectiveChat(b)).toMatchObject({ label: 'claude:sonnet', source: 'env' });
    expect((await f.router.select(Capability.GENERAL_CHAT, b)).id).toBe('claude-cli');
    expect((await f.router.select(Capability.GENERAL_CHAT, a)).id).toBe('codex-cli');
    // B's own change does not touch A's, in either direction.
    await f.service.setSessionChat(b, { provider: 'claude', model: 'haiku' }, { surface: 'chat', actor: 'actor-b' });
    await f.service.setSessionImage(b, 'off', { surface: 'chat', actor: 'actor-b' });
    expect(await f.service.effectiveChat(a)).toMatchObject({ label: 'codex', source: 'session' });
    expect(await f.service.effectiveImage(a)).toMatchObject({ choice: 'claude', source: 'env' });
    expect(await f.service.imageLocalities(a)).toEqual(['LOCAL', 'REMOTE']);
    expect(await f.service.imageLocalities(b)).toEqual({
      allowedLocalities: [],
      // Codex is on PATH here, so its image option is registered and offered as a way back on too.
      switchedOff: { scope: 'SESSION', choices: ['claude', 'codex'], resetRestores: true },
    });
    // B's reset clears only B.
    expect((await f.service.resetSession(b, 'all', { surface: 'chat', actor: 'actor-b' })).status).toBe('CLEARED');
    expect(await f.service.effectiveChat(a)).toMatchObject({ label: 'codex', source: 'session' });
    expect(await f.service.effectiveChat(b)).toMatchObject({ source: 'env' });
    expect((await f.service.resetSession(b, 'all', { surface: 'chat', actor: 'actor-b' })).status).toBe('UNCHANGED');
    // Without an Actor there is no override at all.
    expect(await f.service.effectiveChat({ sessionId: shared.id })).toMatchObject({ source: 'env' });
    expect(await f.service.sessionOverrideCount()).toBe(1);
  });
});

describe('the router applies the selection as data (real CapabilityRouter + ProviderSelectionPolicy)', () => {
  it('chat tier follows the effective selection; Claude keeps code, review, planning, tests and policy-sensitive chat', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex'] });
    const session = await f.openSession();
    for (const capability of CHAT_TIER_CAPABILITIES) {
      expect((await f.router.select(capability, { sessionId: session.id, actorId: ACTOR })).id, capability).toBe('claude-cli');
    }
    await f.service.setSessionChat(scope(session), { provider: 'codex' }, OWNER_CHAT);
    for (const capability of CHAT_TIER_CAPABILITIES) {
      expect((await f.router.select(capability, { sessionId: session.id, actorId: ACTOR })).id, capability).toBe('codex-cli');
      // Another conversation is unaffected.
      expect((await f.router.select(capability, { sessionId: 'other', actorId: ACTOR })).id, capability).toBe('claude-cli');
    }
    for (const capability of CLAUDE_PINNED_CAPABILITIES) {
      expect((await f.router.select(capability, { sessionId: session.id, actorId: ACTOR })).id, capability).toBe('claude-cli');
    }
  });

  it('a Claude alias choice runs on a chat-tier-only instance; it never serves pinned capabilities', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const session = await f.openSession();
    await f.service.setSessionChat(scope(session), { provider: 'claude', model: 'opus' }, OWNER_CHAT);
    const chosen = await f.router.select(Capability.GENERAL_CHAT, { sessionId: session.id, actorId: ACTOR });
    expect(chosen.id).toBe('claude-cli:opus');
    expect(chosen.capabilities.map((c) => c.capability).sort()).toEqual([...CHAT_TIER_CAPABILITIES].sort());
    expect((await f.router.select(Capability.CODE_IMPLEMENTATION, { sessionId: session.id, actorId: ACTOR })).id).toBe('claude-cli');
    expect((await f.router.select(Capability.POLICY_SENSITIVE_CHAT, { sessionId: session.id, actorId: ACTOR })).id).toBe('claude-cli');
  });

  it('an Ollama model choice adds one on-demand local instance and serves the chat tier only', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['ollama'] });
    const session = await f.openSession();
    const validated = await f.service.validateChatToken('ollama:granite3.3:8b');
    expect(validated).toEqual({ ok: true, choice: { provider: 'ollama', model: 'granite3.3:8b' } });
    if (!validated.ok) throw new Error('unreachable');
    await f.service.setSessionChat(scope(session), validated.choice, OWNER_CHAT);
    const chosen = await f.router.select(Capability.SUMMARIZATION, { sessionId: session.id, actorId: ACTOR });
    expect(chosen.id).toBe('ollama-cli:granite3.3:8b');
    expect(chosen.executionLocality).toBe('LOCAL');
    expect((await f.router.select(Capability.CODE_IMPLEMENTATION, { sessionId: session.id, actorId: ACTOR })).id).toBe('claude-cli');
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

  it('no runtime selection (ops default or session override) ever changes code, review, planning, tests or policy routing', async () => {
    // Two installations: env selects Ollama (main: Ollama registered, CAP-009 local code fallback), and env selects
    // Claude with Ollama registered only for switching (main: Ollama not registered, so no code fallback).
    const routes = async (f: ReturnType<typeof selectionFixture>, sessionId: string) => {
      const seen: string[] = [];
      for (const capability of CLAUDE_PINNED_CAPABILITIES) {
        try {
          seen.push(`${capability}:${(await f.router.select(capability, { sessionId, actorId: ACTOR })).id}`);
        } catch (err) {
          seen.push(`${capability}:${err instanceof NoProviderAvailableError ? 'none' : 'error'}`);
        }
      }
      return seen;
    };
    for (const env of [{ QUOKY_CHAT_PROVIDER: 'ollama' }, { QUOKY_CHAT_PROVIDER: 'claude', OLLAMA_MODEL: 'llama3.1' }]) {
      for (const claudeReady of [true, false]) {
        const f = selectionFixture({ env, present: ['codex', 'ollama'] });
        f.ready.set('claude-cli', claudeReady);
        const session = await f.openSession();
        const baseline = await routes(f, session.id);
        const changes: Array<() => Promise<unknown> | unknown> = [
          () => f.service.setDefaultChat({ provider: 'ollama' }, OPS),
          () => f.service.setDefaultChat({ provider: 'codex' }, OPS),
          () => f.service.setDefaultChat({ provider: 'claude', model: 'opus' }, OPS),
          () => f.service.setSessionChat(scope(session), { provider: 'ollama', model: 'granite3.3:8b' }, OWNER_CHAT),
          () => f.service.setSessionChat(scope(session), { provider: 'ollama' }, OWNER_CHAT),
          () => f.service.setDefaultChat(null, OPS),
        ];
        for (const change of changes) {
          await change();
          expect(await routes(f, session.id), JSON.stringify({ env, claudeReady })).toEqual(baseline);
        }
        // The static install config alone decides the CAP-009 fallback, exactly as on main.
        const expectedFallback = env.QUOKY_CHAT_PROVIDER === 'ollama' ? 'ollama-cli' : 'none';
        expect(baseline.find((r) => r.startsWith('CODE_IMPLEMENTATION:'))).toBe(
          `CODE_IMPLEMENTATION:${claudeReady ? 'claude-cli' : expectedFallback}`,
        );
        expect(baseline.find((r) => r.startsWith('CODE_REVIEW:'))).toBe(`CODE_REVIEW:${claudeReady ? 'claude-cli' : 'none'}`);
      }
    }
  });

  it('embedding and other unpinned capabilities get no preference (legacy priority path)', async () => {
    const f = selectionFixture();
    expect(await f.service.preferenceFor(Capability.EMBEDDING, {})).toBeNull();
  });
});

// ADR-0116 D2/D3: the selection source reaches Core as data with the resolved provider (real router + real policy).
describe('selection source for the learning-example egress (ADR-0116)', () => {
  const ctx = (session: { readonly id: string }) => ({ sessionId: session.id, actorId: ACTOR });

  it('the derived default is never an owner selection (QUOKY_OLLAMA_ENABLED=false read as claude)', async () => {
    const f = selectionFixture({ env: { QUOKY_OLLAMA_ENABLED: 'false' } });
    const session = await f.openSession();
    expect(await f.service.effectiveChat(ctx(session))).toMatchObject({ label: 'claude:sonnet', source: 'default' });
    const resolved = await f.router.resolve(Capability.GENERAL_CHAT, ctx(session));
    expect(resolved.provider.id).toBe('claude-cli');
    expect(resolved.source).toBe('NOT_OWNER_SELECTED');
    expect(await f.service.preferenceFor(Capability.GENERAL_CHAT, ctx(session))).not.toHaveProperty('ownerSelectedKey');
  });

  it('an explicitly set QUOKY_CHAT_PROVIDER, the operations-UI default and a session override are owner selections', async () => {
    const env = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    expect(await env.router.resolve(Capability.GENERAL_CHAT, ctx(await env.openSession()))).toMatchObject({
      source: 'OWNER_SELECTED',
    });

    const ops = selectionFixture({ env: { QUOKY_OLLAMA_ENABLED: 'false' } });
    const opsSession = await ops.openSession();
    ops.service.setDefaultChat({ provider: 'claude' }, OPS);
    expect(await ops.service.effectiveChat(ctx(opsSession))).toMatchObject({ source: 'persisted' });
    const viaOps = await ops.router.resolve(Capability.GENERAL_CHAT, ctx(opsSession));
    expect([viaOps.provider.id, viaOps.source]).toEqual(['claude-cli', 'OWNER_SELECTED']);

    const session = selectionFixture({ env: { QUOKY_OLLAMA_ENABLED: 'false' } });
    const own = await session.openSession();
    await session.service.setSessionChat(scope(own), { provider: 'claude', model: 'opus' }, OWNER_CHAT);
    const viaSession = await session.router.resolve(Capability.GENERAL_CHAT, ctx(own));
    expect([viaSession.provider.id, viaSession.source]).toEqual(['claude-cli:opus', 'OWNER_SELECTED']);
    // Another conversation of the same owner still runs on the derived default.
    expect(await session.router.resolve(Capability.GENERAL_CHAT, ctx(await session.openSession()))).toMatchObject({
      source: 'NOT_OWNER_SELECTED',
    });
  });

  it('Claude reached only as the selection-time fallback is never an owner selection', async () => {
    // The explicitly chosen Codex is not ready: Claude answers as the fallback.
    const codex = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'codex' } });
    codex.ready.set('codex-cli', false);
    const viaFallback = await codex.router.resolve(Capability.GENERAL_CHAT, ctx(await codex.openSession()));
    expect([viaFallback.provider.id, viaFallback.source]).toEqual(['claude-cli', 'NOT_OWNER_SELECTED']);

    // The explicitly chosen `claude:opus` instance is not ready: the default Claude instance is the fallback.
    const opus = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const own = await opus.openSession();
    await opus.service.setSessionChat(scope(own), { provider: 'claude', model: 'opus' }, OWNER_CHAT);
    opus.ready.set('claude-cli:opus', false);
    const viaOpusFallback = await opus.router.resolve(Capability.GENERAL_CHAT, ctx(own));
    expect([viaOpusFallback.provider.id, viaOpusFallback.source]).toEqual(['claude-cli', 'NOT_OWNER_SELECTED']);

    // An explicitly chosen local Ollama answers as itself (LOCAL keeps ADR-0107 anyway); unready → Claude, not owner's.
    const local = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'ollama' } });
    const viaLocal = await local.router.resolve(Capability.GENERAL_CHAT, ctx(await local.openSession()));
    expect([viaLocal.provider.executionLocality, viaLocal.source]).toEqual(['LOCAL', 'OWNER_SELECTED']);
    local.ready.set(viaLocal.provider.id, false);
    const viaLocalFallback = await local.router.resolve(Capability.GENERAL_CHAT, ctx(await local.openSession()));
    expect([viaLocalFallback.provider.id, viaLocalFallback.source]).toEqual(['claude-cli', 'NOT_OWNER_SELECTED']);
  });

  it('pinned capabilities and the fail-safe answer never carry an owner selection', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const session = await f.openSession();
    for (const capability of CLAUDE_PINNED_CAPABILITIES) {
      expect(await f.router.resolve(capability, ctx(session)), capability).toMatchObject({ source: 'NOT_OWNER_SELECTED' });
    }
    const broken = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    (broken.service as unknown as { deps: { sessions: () => unknown } }).deps.sessions = () => ({
      get: async () => {
        throw new Error('session store unavailable');
      },
    });
    // Fail closed: the safe-default answer names no owner selection, even with an explicit QUOKY_CHAT_PROVIDER.
    const failSafe = await broken.service.preferenceFor(Capability.GENERAL_CHAT, { sessionId: 's', actorId: ACTOR });
    expect(failSafe).toEqual({ eligible: ['claude-cli'], order: 'listed' });
    expect(await broken.router.resolve(Capability.GENERAL_CHAT, { sessionId: 's', actorId: ACTOR })).toMatchObject({
      source: 'NOT_OWNER_SELECTED',
    });
  });
});

describe('image understanding: eligibility and the Core locality policy follow the effective selection', () => {
  it('REMOTE is allowed only while the effective image choice is claude; switching away stops egress at once', async () => {
    const f = selectionFixture({
      env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
    });
    const session = await f.openSession();
    expect(await f.service.imageLocalities({ sessionId: session.id, actorId: ACTOR })).toEqual(['LOCAL', 'REMOTE']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, { sessionId: session.id, actorId: ACTOR })).id).toBe('claude-vision-cli');

    await f.service.setSessionImage(scope(session), 'ollama', OWNER_CHAT);
    expect(await f.service.imageLocalities({ sessionId: session.id, actorId: ACTOR })).toEqual(['LOCAL']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, { sessionId: session.id, actorId: ACTOR })).id).toBe('ollama-vision-cli');

    await f.service.setSessionImage(scope(session), 'off', OWNER_CHAT);
    // An explicit `off` allows no locality and says where it was switched off and how to turn it back on.
    expect(await f.service.imageLocalities({ sessionId: session.id, actorId: ACTOR })).toEqual({
      allowedLocalities: [],
      switchedOff: { scope: 'SESSION', choices: ['claude', 'ollama'], resetRestores: true },
    });
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING, { sessionId: session.id, actorId: ACTOR })).rejects.toBeInstanceOf(
      NoProviderAvailableError,
    );

    // The operations-UI default switches every conversation without an override immediately.
    f.service.setDefaultImage('off', OPS);
    expect(await f.service.imageLocalities({})).toEqual({
      allowedLocalities: [],
      switchedOff: { scope: 'DEFAULT', choices: ['claude', 'ollama'], resetRestores: false },
    });
    // The session override is `off` too, and resetting it would not turn images back on any more.
    expect(await f.service.imageLocalities({ sessionId: session.id, actorId: ACTOR })).toMatchObject({
      switchedOff: { scope: 'SESSION', resetRestores: false },
    });
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING, {})).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('with nothing configured the Claude vision provider is registered but never eligible, and REMOTE stays closed', async () => {
    const f = selectionFixture();
    expect(f.catalog.claudeVision?.id).toBe('claude-vision-cli');
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL']);
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING)).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('codex (ADR-0111 amendment 2026-10-08) is treated like claude: REMOTE only while it is the effective image choice', async () => {
    const f = selectionFixture({
      env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'codex', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
    });
    const session = await f.openSession();
    const ctx = scope(session);
    expect(await f.service.effectiveImage(ctx)).toMatchObject({ choice: 'codex', source: 'env' });
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL', 'REMOTE']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, ctx)).id).toBe('codex-vision-cli');
    // Only the effective image provider is eligible: Claude's vision instance never answers while codex is chosen.
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'codex-vision-cli')).toBe(true);
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'claude-vision-cli')).toBe(false);
    // The Codex image provider never becomes a chat-tier or pinned candidate.
    expect((await f.service.preferenceFor(Capability.GENERAL_CHAT, ctx))?.eligible).not.toContain('codex-vision-cli');
    expect((await f.service.preferenceFor(Capability.CODE_REVIEW, ctx))?.eligible).not.toContain('codex-vision-cli');

    // Switching to the local model closes REMOTE on the very next image turn; codex is no longer eligible.
    await f.service.setSessionImage(ctx, 'ollama', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, ctx)).id).toBe('ollama-vision-cli');
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'codex-vision-cli')).toBe(false);

    await f.service.setSessionImage(ctx, 'off', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual({
      allowedLocalities: [],
      switchedOff: { scope: 'SESSION', choices: ['claude', 'codex', 'ollama'], resetRestores: true },
    });
    await expect(f.router.select(Capability.IMAGE_UNDERSTANDING, ctx)).rejects.toBeInstanceOf(NoProviderAvailableError);

    // Back to codex in this conversation: REMOTE opens again, for this (Session, Actor) only.
    await f.service.setSessionImage(ctx, 'codex', OWNER_CHAT);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL', 'REMOTE']);
    f.service.setDefaultImage('ollama', OPS);
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL']);
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL', 'REMOTE']);
  });

  it('codex as the operations-UI default opens REMOTE for every conversation without an override; claude chosen there keeps codex ineligible', async () => {
    const f = selectionFixture({ env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' }, present: ['codex'] });
    expect(f.service.validateImageToken('codex')).toEqual({ ok: true, choice: 'codex' });
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, {})).id).toBe('claude-vision-cli');
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, {}, 'codex-vision-cli')).toBe(false);
    f.service.setDefaultImage('codex', OPS);
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL', 'REMOTE']);
    expect((await f.router.select(Capability.IMAGE_UNDERSTANDING, {})).id).toBe('codex-vision-cli');
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, {}, 'claude-vision-cli')).toBe(false);
  });

  it('codex cannot be chosen for images when its CLI is absent and nothing configures it', () => {
    const f = selectionFixture({ env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' } });
    expect(f.service.validateImageToken('codex')).toEqual({ ok: false, refusal: 'IMAGE_OPTION_UNAVAILABLE' });
  });

  it('ollama cannot be chosen for images without a configured local vision model', () => {
    const f = selectionFixture();
    expect(f.service.validateImageToken('ollama')).toEqual({ ok: false, refusal: 'IMAGE_OPTION_UNAVAILABLE' });
    expect(f.service.validateImageToken('gpt')).toEqual({ ok: false, refusal: 'IMAGE_CHOICE_INVALID' });
    expect(f.service.validateImageToken('OFF')).toEqual({ ok: true, choice: 'off' });
  });
});

describe('dispatch-time eligibility (synchronous, live selection)', () => {
  it('ollama → off while the re-selection awaits readiness: the old provider comes back but is no longer eligible', async () => {
    const f = selectionFixture({ env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'ollama', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' } });
    const session = await f.openSession();
    const ctx = scope(session);
    const vision = f.catalog.ollamaVision;
    if (vision === undefined) throw new Error('no vision provider');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let probing!: () => void;
    const probed = new Promise<void>((resolve) => (probing = resolve));
    Object.assign(vision, {
      isAvailable: async () => {
        probing();
        await gate;
        return true;
      },
    });
    const selecting = f.router.select(Capability.IMAGE_UNDERSTANDING, ctx);
    await probed;
    // The owner switches this conversation's images off while the probe is in flight.
    expect((await f.service.setSessionImage(ctx, 'off', OWNER_CHAT)).status).toBe('SET');
    release();
    const provider = await selecting;
    expect(provider.id).toBe('ollama-vision-cli'); // eligibility was decided before the await
    // The locality policy is closed now too; the synchronous dispatch-time check below is what catches this race.
    expect(await f.service.imageLocalities(ctx)).toMatchObject({ allowedLocalities: [] });
    expect(f.router.isStillEligible(Capability.IMAGE_UNDERSTANDING, ctx, provider)).toBe(false);
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'ollama-vision-cli')).toBe(false);
  });

  it.each([
    ['claude', { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' }, 'claude-vision-cli'],
    ['codex', { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'codex' }, 'codex-vision-cli'],
    ['ollama', { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'ollama', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' }, 'ollama-vision-cli'],
  ] as const)('write fence (%s): an `off` committed to storage but not yet returned to the setter is never dispatched past', async (_label, env, visionId) => {
    const f = selectionFixture({ env });
    const session = await f.openSession();
    const ctx = scope(session);
    const provider = await f.router.select(Capability.IMAGE_UNDERSTANDING, ctx);
    expect(provider.id).toBe(visionId);
    expect(f.router.isStillEligible(Capability.IMAGE_UNDERSTANDING, ctx, provider)).toBe(true);

    // The save COMMITS (the row holds `off`) and then pauses before it returns to the lock and the setter.
    const save = f.sessionStore.save.bind(f.sessionStore);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let committed!: () => void;
    const didCommit = new Promise<void>((resolve) => (committed = resolve));
    f.sessionStore.save = async (row: Session) => {
      const result = await save(row);
      committed();
      await gate;
      return result;
    };
    const writing = f.service.setSessionImage(ctx, 'off', OWNER_CHAT);
    await didCommit;
    // Storage already says off (checked on the raw row: a service read would refresh the mirror itself).
    expect(f.rows.get(session.id)?.metadata?.[SESSION_SELECTION_METADATA_KEY]).toMatchObject({ byActor: { [ACTOR]: { image: 'off' } } });
    // The dispatch decision a turn makes right now: not eligible, so nothing is executed.
    const dispatch = async () => {
      if (f.router.isStillEligible(Capability.IMAGE_UNDERSTANDING, ctx, provider)) await provider.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'x' });
    };
    await dispatch();
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, visionId)).toBe(false);
    expect(f.executed).toEqual([]);
    release();
    expect((await writing).status).toBe('SET');
    // After the write: the mirror holds `off`, still not eligible; still nothing executed.
    await dispatch();
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, visionId)).toBe(false);
    expect(f.executed).toEqual([]);
  });

  it('write fence: a failed write keeps the previous value and clears the fence', async () => {
    const f = selectionFixture({ env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' } });
    const session = await f.openSession();
    const ctx = scope(session);
    await f.service.effectiveImage(ctx); // mirrored: claude
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.sessionStore.save = async () => {
      await gate;
      throw new Error('disk full');
    };
    const writing = f.service.setSessionImage(ctx, 'off', OWNER_CHAT);
    await Promise.resolve();
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'claude-vision-cli')).toBe(false); // fenced
    release();
    expect((await writing).status).toBe('WRITE_FAILED');
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, 'claude-vision-cli')).toBe(true); // old value, fence cleared
  });

  it('off rejects every provider; an unchanged selection stays eligible; an unmirrored scope fails closed', async () => {
    const f = selectionFixture({ env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' } });
    const session = await f.openSession();
    const ctx = scope(session);
    const provider = await f.router.select(Capability.IMAGE_UNDERSTANDING, ctx);
    expect(f.router.isStillEligible(Capability.IMAGE_UNDERSTANDING, ctx, provider)).toBe(true);
    f.service.setDefaultImage('off', OPS);
    for (const key of ['claude-vision-cli', 'ollama-vision-cli', 'claude-cli']) {
      expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, ctx, key), key).toBe(false);
    }
    expect(f.service.isEligible(Capability.IMAGE_UNDERSTANDING, { sessionId: 'never-read', actorId: ACTOR }, 'claude-vision-cli')).toBe(false);
    // A chat-tier check follows the live selection the same way.
    expect(f.service.isEligible(Capability.GENERAL_CHAT, ctx, 'claude-cli')).toBe(true);
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

  it('refuses an installed model that cannot chat (embedding-only) at selection time and leaves it out of the list', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['ollama'] });
    f.inventory = { status: 'OK', models: ['granite3.3:8b'], nonChat: ['nomic-embed-text:latest'] };
    expect(await f.service.validateChatToken('ollama:nomic-embed-text')).toEqual({ ok: false, refusal: 'OLLAMA_MODEL_NOT_CHAT' });
    expect(await f.service.validateChatToken('ollama:nomic-embed-text:latest')).toEqual({ ok: false, refusal: 'OLLAMA_MODEL_NOT_CHAT' });
    expect(await f.service.validateChatToken('ollama:granite3.3:8b')).toMatchObject({ ok: true });
    const tokens = (await f.service.options()).filter((o) => o.tier === 'chat').map((o) => o.token);
    expect(tokens).toContain('ollama:granite3.3:8b');
    expect(tokens.some((token) => token.includes('nomic-embed'))).toBe(false);
  });

  it('a configured OLLAMA_MODEL that cannot chat is not re-added to the list', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude', OLLAMA_MODEL: 'nomic-embed-text' }, present: ['ollama'] });
    f.inventory = { status: 'OK', models: ['granite3.3:8b'], nonChat: ['nomic-embed-text:latest'] };
    const tokens = (await f.service.options()).filter((o) => o.tier === 'chat').map((o) => o.token);
    expect(tokens.filter((token) => token.startsWith('ollama:'))).toEqual(['ollama:granite3.3:8b']);
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
      ['image', 'codex', true, 'OPENAI', false],
      ['image', 'off', undefined, 'NONE', false],
    ]);
    // Listing never instantiated anything on demand and never executed a provider.
    expect(f.catalog.providers.map((p) => p.id)).toEqual(['claude-cli', 'ollama-cli', 'codex-cli', 'claude-vision-cli', 'codex-vision-cli']);
    expect(f.executed).toEqual([]);
  });

  it('counts open conversations that carry their own override', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const a = await f.openSession();
    await f.openSession();
    expect(await f.service.sessionOverrideCount()).toBe(0);
    await f.service.setSessionImage(scope(a), 'off', OWNER_CHAT);
    expect(await f.service.sessionOverrideCount()).toBe(1);
  });
});

describe('audit and fail-safe', () => {
  it('logs every selection change with surface, actor, scope, tier and the label (no content)', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex'] });
    const session = await f.openSession();
    await f.service.setSessionChat(scope(session), { provider: 'codex' }, OWNER_CHAT);
    f.service.setDefaultImage('off', OPS);
    await f.service.resetSession(scope(session), 'all', OWNER_CHAT);
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
    expect(await f.service.preferenceFor(Capability.GENERAL_CHAT, { sessionId: 's', actorId: ACTOR })).toEqual({ eligible: ['claude-cli'], order: 'listed' });
    expect(await f.service.preferenceFor(Capability.IMAGE_UNDERSTANDING, { sessionId: 's', actorId: ACTOR })).toEqual({ eligible: [], order: 'listed' });
    expect(await f.service.imageLocalities({ sessionId: 's', actorId: ACTOR })).toEqual(['LOCAL']);
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

describe('a runtime selection change leaves unrelated providers alone (live QA D16)', () => {
  it('switching the image model never re-probes or drops the embedding provider\'s cached readiness', async () => {
    const f = selectionFixture({
      env: { QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
      present: ['codex'],
    });
    let embedReady = true;
    let embedProbes = 0;
    const embed: AiProvider = {
      id: 'ollama-embed-cli',
      capabilities: [{ capability: Capability.EMBEDDING, priority: 100 }],
      executionLocality: 'LOCAL',
      isAvailable: async () => {
        embedProbes += 1;
        return embedReady;
      },
      execute: async () => ({ text: '[]', artifacts: [] }),
    };
    // The production manager caches readiness (the fixture's own manager does not).
    const manager = new AiProviderManager([...f.catalog.providers, embed], { availabilityTtlMs: 30_000 });
    const router = new CapabilityRouter(manager, f.service);
    const session = await f.openSession();
    const ctx = scope(session);

    expect((await router.select(Capability.EMBEDDING, ctx)).id).toBe('ollama-embed-cli');
    expect((await router.select(Capability.IMAGE_UNDERSTANDING, ctx)).id).toBe('claude-vision-cli');
    await f.service.setSessionImage(ctx, 'codex', OWNER_CHAT);
    expect((await router.select(Capability.IMAGE_UNDERSTANDING, ctx)).id).toBe('codex-vision-cli');
    f.service.setDefaultImage('ollama', OPS);
    await f.service.setSessionChat(ctx, { provider: 'ollama' }, OWNER_CHAT);
    await router.select(Capability.GENERAL_CHAT, ctx);

    // Had any of those changes invalidated it, this re-probe would read "not ready" and recall would fall back.
    embedReady = false;
    expect((await router.select(Capability.EMBEDDING, ctx)).id).toBe('ollama-embed-cli');
    expect(embedProbes).toBe(1);
  });
});

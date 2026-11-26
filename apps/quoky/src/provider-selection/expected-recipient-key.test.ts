import { describe, expect, it } from 'vitest';
import { Capability } from '@quoky/core';
import { CHAT_TIER_CAPABILITIES } from './selection-choices';
import { selectionFixture } from './test-support';

/**
 * ADR-0121 amendment A8.3 (OQ1-1): `ProviderSelectionService.expectedRecipientKey`, the data the Core recipient comparison reads.
 * The first owner-set layer names the key; a derived default counts only while it is the Claude CLI; any doubt is `undefined`.
 */

const ACTOR = 'actor-owner';
const OWNER_CHAT = { surface: 'chat' as const, actor: ACTOR };
const OPS = { surface: 'ops-ui' as const, actor: ACTOR };
const GEMINI_ENV = { QUOKY_GEMINI_API_KEY: ['AI', 'za', 'K'.repeat(11), '7x'.repeat(12)].join(''), QUOKY_GEMINI_MODEL: 'gemini-3.5-flash-lite' } as const;
const scoped = (session: { readonly id: string }) => ({ sessionId: session.id, actorId: ACTOR });

describe('expectedRecipientKey layer matrix (A8.3a)', () => {
  it('session override beats persisted and env, and names its provider key', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex'] });
    const session = await f.openSession();
    f.service.setDefaultChat({ provider: 'codex' }, OPS);
    await f.service.setSessionChat(scoped(session), { provider: 'codex' }, OWNER_CHAT);
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, scoped(session))).toBe(f.catalog.codex?.id);
    await f.service.setSessionChat(scoped(session), { provider: 'claude', model: 'opus' }, OWNER_CHAT);
    const key = f.service.expectedRecipientKey(Capability.GENERAL_CHAT, scoped(session));
    expect(key).toBe((await f.service.effectiveChat(scoped(session))).provider.id);
  });

  it('persisted ops-UI default names its key; a request with no conversation uses the global layers', async () => {
    const f = selectionFixture({ present: ['codex'] });
    f.service.setDefaultChat({ provider: 'codex' }, OPS);
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBe(f.catalog.codex?.id);
  });

  it('env (QUOKY_CHAT_PROVIDER) names its key', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBe(f.catalog.claude.id);
  });

  it('env on an HTTP vendor names the vendor key, even for a work-text request (the vendor exclusion makes the Claude CLI unexpected, A8.3d)', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'gemini', ...GEMINI_ENV } });
    const vendor = (await f.service.effectiveChat()).provider.id;
    expect(vendor).not.toBe(f.catalog.claude.id);
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBe(vendor);
    expect(f.service.expectedRecipientKey(Capability.SUMMARIZATION, { workText: true })).toBe(vendor);
  });

  it('derived default is the Claude CLI (QUOKY_OLLAMA_ENABLED=false): expected', () => {
    const f = selectionFixture({ env: { QUOKY_OLLAMA_ENABLED: 'false' } });
    expect(f.service.globalChat()).toMatchObject({ source: 'default' });
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBe(f.catalog.claude.id);
  });

  it('derived default is Ollama (a LOCAL model): nothing is expected', () => {
    const f = selectionFixture();
    expect(f.service.globalChat()).toMatchObject({ source: 'default', label: 'ollama:llama3.1' });
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBeUndefined();
  });

  it('derived Ollama that cannot run here falls to the Claude CLI with no owner layer skipped: expected (ruling c)', () => {
    const f = selectionFixture();
    Object.defineProperty(f.catalog, 'ollama', { value: undefined });
    const chat = f.service.globalChat();
    expect(chat).toMatchObject({ source: 'default', ignored: ['default'] });
    expect(chat.provider).toBe(f.catalog.claude);
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBe(f.catalog.claude.id);
  });

  it('an owner-set layer skipped because it cannot run makes nothing expected (the owner choice did not run)', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const session = await f.openSession();
    await f.service.effectiveChat(scoped(session));
    f.service.setDefaultChat({ provider: 'codex' }, OPS);
    // No Codex registered: the persisted layer is skipped, env (an owner layer) would serve, but a layer was skipped.
    const chat = f.service.globalChat();
    expect(chat.ignored).toContain('persisted');
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBeUndefined();
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, scoped(session))).toBeUndefined();
  });

  it('does not reuse ownerSelectedKey: after a skipped owner layer the next resolvable layer is NOT expected', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    f.service.setDefaultChat({ provider: 'codex' }, OPS);
    const preference = await f.service.preferenceFor(Capability.GENERAL_CHAT, {});
    expect(preference?.ownerSelectedKey).toBe(f.catalog.claude.id);
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBeUndefined();
  });
});

describe('expectedRecipientKey fail-closed rules', () => {
  it('only the chat tier: image understanding, pinned and unknown capabilities answer undefined', () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    for (const capability of CHAT_TIER_CAPABILITIES) expect(f.service.expectedRecipientKey(capability, {}), capability).toBe(f.catalog.claude.id);
    expect(f.service.expectedRecipientKey(Capability.IMAGE_UNDERSTANDING, {})).toBeUndefined();
  });

  it('a locality-constrained request answers undefined', () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    expect(f.service.expectedRecipientKey(Capability.SUMMARIZATION, { requiredLocality: 'LOCAL' })).toBeUndefined();
  });

  it('an unmirrored scope answers undefined until the scope was read', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    const session = await f.openSession();
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, scoped(session))).toBeUndefined();
    await f.service.effectiveChat(scoped(session));
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, scoped(session))).toBe(f.catalog.claude.id);
  });

  it('a session write in flight answers undefined', async () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: ['codex'] });
    const session = await f.openSession();
    await f.service.effectiveChat(scoped(session));
    const write = f.service.setSessionChat(scoped(session), { provider: 'codex' }, OWNER_CHAT);
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, scoped(session))).toBeUndefined();
    await write;
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, scoped(session))).toBe(f.catalog.codex?.id);
  });

  it('never throws: a store that throws is undefined', () => {
    const f = selectionFixture({ env: { QUOKY_CHAT_PROVIDER: 'claude' } });
    f.store.get = () => {
      throw new Error('boom');
    };
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBeUndefined();
  });
});

describe('change detector (A8.3a: "any change to the derived default makes it unexpected until a Strict step approves it")', () => {
  it('the derived default with Ollama off is exactly catalog.claude; fails if that ever changes', () => {
    const f = selectionFixture({ env: { QUOKY_OLLAMA_ENABLED: 'false' } });
    const chat = f.service.globalChat();
    expect(chat.source).toBe('default');
    expect(chat.provider).toBe(f.catalog.claude);
    expect(chat.choice).toEqual({ provider: 'claude' });
    expect(f.service.expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBe(f.catalog.claude.id);
  });
});

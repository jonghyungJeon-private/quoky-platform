import { describe, expect, it } from 'vitest';
import { Capability } from '@quoky/core';
import { CHAT_TIER_CAPABILITIES } from './selection-choices';
import { ProviderSelectionService } from './provider-selection-service';
import { selectionFixture, type SelectionFixture } from './test-support';

/**
 * A6 R2, owner decision D6 / amendment C9: a request carrying the work-text constraint (one Jira / Slack item summary)
 * never reaches an HTTP API vendor (OpenAI, Gemini) the owner selected for chat, unless
 * `QUOKY_WORK_TEXT_VENDOR_ALLOWED` is set. The owner's selection is unchanged. Offline: every provider is stubbed.
 */

const OPENAI_ENV = { QUOKY_OPENAI_API_KEY: ['sk', 'quokyapp', 'K'.repeat(10) + '7x'.repeat(9)].join('-'), QUOKY_OPENAI_MODEL: 'gpt-4.1-mini' } as const;
const GEMINI_ENV = { QUOKY_GEMINI_API_KEY: ['AI', 'za', 'K'.repeat(11), '7x'.repeat(12)].join(''), QUOKY_GEMINI_MODEL: 'gemini-3.5-flash-lite' } as const;
const ACTOR = 'actor-owner';

/** The same service over the same deps, with the D6 opt-in. */
function withVendorAllowed(f: SelectionFixture): ProviderSelectionService {
  const deps = (f.service as unknown as { deps: ConstructorParameters<typeof ProviderSelectionService>[0] }).deps;
  return new ProviderSelectionService({ ...deps, workTextVendorAllowed: true });
}

const VENDORS = [
  { name: 'openai', env: { QUOKY_CHAT_PROVIDER: 'openai', ...OPENAI_ENV }, key: 'openai-api' },
  { name: 'gemini', env: { QUOKY_CHAT_PROVIDER: 'gemini', ...GEMINI_ENV }, key: 'gemini-api' },
] as const;

describe.each(VENDORS)('D6 with the chat selection on $name', ({ env, key }) => {
  it('serves a work-text request from the Claude CLI only, without naming an owner selection', async () => {
    const f = selectionFixture({ env });
    const session = await f.openSession();
    const ctx = { sessionId: session.id, actorId: ACTOR, workText: true as const };
    for (const capability of CHAT_TIER_CAPABILITIES) {
      const preference = await f.service.preferenceFor(capability, ctx);
      expect(preference, capability).toEqual({ eligible: [f.catalog.claude.id], order: 'listed' });
      expect(preference && 'ownerSelectedKey' in preference, capability).toBe(false);
      expect(f.service.isEligible(capability, ctx, key), capability).toBe(false);
      expect(f.service.isEligible(capability, ctx, f.catalog.claude.id), capability).toBe(true);
    }
  });

  it('routes the work-text summary to the Claude CLI while a plain request still goes to the vendor', async () => {
    const f = selectionFixture({ env });
    expect((await f.router.select(Capability.SUMMARIZATION, { workText: true })).id).toBe(f.catalog.claude.id);
    expect((await f.router.select(Capability.SUMMARIZATION)).id).toBe(key);
  });

  it('with the separate opt-in it is the normal preference', async () => {
    const f = selectionFixture({ env });
    const session = await f.openSession();
    const allowed = withVendorAllowed(f);
    const ctx = { sessionId: session.id, actorId: ACTOR, workText: true as const };
    const plain = { sessionId: session.id, actorId: ACTOR };
    for (const capability of CHAT_TIER_CAPABILITIES) {
      const preference = await allowed.preferenceFor(capability, ctx);
      expect(preference, capability).toEqual(await f.service.preferenceFor(capability, plain));
      expect(preference?.eligible, capability).toContain(key);
      expect(allowed.isEligible(capability, ctx, key), capability).toBe(true);
    }
  });

  it('without workText nothing changes, with or without a session', async () => {
    const f = selectionFixture({ env });
    const session = await f.openSession();
    for (const capability of CHAT_TIER_CAPABILITIES) {
      for (const ctx of [{}, { sessionId: session.id, actorId: ACTOR }]) {
        const preference = await f.service.preferenceFor(capability, ctx);
        expect(preference?.eligible, capability).toEqual([key, f.catalog.claude.id]);
        expect(f.service.isEligible(capability, ctx, key), capability).toBe(true);
      }
    }
  });

  it('does not touch the capabilities outside the chat tier', async () => {
    const f = selectionFixture({ env });
    for (const capability of [Capability.CODE_IMPLEMENTATION, Capability.CODE_REVIEW]) {
      const withText = await f.service.preferenceFor(capability, { workText: true });
      const without = await f.service.preferenceFor(capability, {});
      expect(withText).toEqual(without);
    }
  });
});

describe('D6 with a Claude or Ollama chat selection', () => {
  it.each([
    ['claude', { env: { QUOKY_CHAT_PROVIDER: 'claude' }, present: [] as string[] }],
    ['ollama', { env: { QUOKY_CHAT_PROVIDER: 'ollama' }, present: ['ollama'] }],
  ])('workText changes nothing for %s', async (_name, options) => {
    const f = selectionFixture(options);
    const session = await f.openSession();
    for (const capability of CHAT_TIER_CAPABILITIES) {
      const plain = await f.service.preferenceFor(capability, { sessionId: session.id, actorId: ACTOR });
      const work = await f.service.preferenceFor(capability, { sessionId: session.id, actorId: ACTOR, workText: true });
      expect(work, capability).toEqual(plain);
      for (const key of plain?.eligible ?? []) {
        expect(f.service.isEligible(capability, { sessionId: session.id, actorId: ACTOR, workText: true }, key), `${capability} ${key}`).toBe(
          f.service.isEligible(capability, { sessionId: session.id, actorId: ACTOR }, key),
        );
      }
    }
  });
});

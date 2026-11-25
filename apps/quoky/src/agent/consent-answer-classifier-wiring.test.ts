import { describe, expect, it } from 'vitest';
import { Capability, type AiProvider } from '@quoky/core';
import { buildConsentClassifierSwitch } from './consent-answer-classifier-wiring';
import { parseConsentAnswerConfig } from './consent-answer-config';

// A6 classifier wiring: the composition root builds the switch from config. `off` is exactly the old hard-wired value and touches
// no router; `on` (refused at startup until A6-S4) builds the adapter, which takes the turn's chat facts and the cap charge per call.

describe('buildConsentClassifierSwitch', () => {
  it('off (and unset) is { mode: "off" } and never touches the router', () => {
    const router = { select: async (): Promise<AiProvider> => { throw new Error('router must not be used'); } };
    expect(buildConsentClassifierSwitch('off', router, () => 0)).toEqual({ mode: 'off' });
    expect(buildConsentClassifierSwitch(undefined, router, () => 0)).toEqual({ mode: 'off' });
  });

  it('on builds the adapter: no chat facts is `unclear` without a call or a charge; same egress charges once and calls once; a different egress or no stronger tier neither', async () => {
    const selected: Capability[] = [];
    const executed: unknown[] = [];
    const providerOf = (over: Partial<AiProvider> = {}): AiProvider => ({ id: 'claude-cli', executionLocality: 'REMOTE', supportsStrongerIntentSelection: true, capabilities: [], isAvailable: async () => true, execute: async (request: unknown) => (executed.push(request), { text: '{"label":"yes"}' }), ...over }) as unknown as AiProvider;
    const switchOf = (provider: AiProvider) => {
      const built = buildConsentClassifierSwitch('on', { select: async (capability: Capability) => (selected.push(capability), provider) }, () => 0);
      if (built.mode !== 'on') throw new Error('unreachable');
      return built.classify;
    };
    const request = { question: '보낼까요?', reply: '그래' };
    let charges = 0;
    const charge = () => (charges += 1, true);
    const chat = { id: 'claude-cli', locality: 'REMOTE' as const };
    expect(await switchOf(providerOf())(request, { charge })).toBe('unclear');
    expect([charges, executed.length]).toEqual([0, 0]);
    expect(await switchOf(providerOf())(request, { chat, charge })).toBe('yes');
    expect([charges, executed.length]).toEqual([1, 1]);
    expect(selected.every((capability) => capability === Capability.INTENT_SELECTION)).toBe(true);
    expect(await switchOf(providerOf({ id: 'other-cli' }))(request, { chat, charge })).toBe('unclear');
    expect(await switchOf(providerOf({ supportsStrongerIntentSelection: false }))(request, { chat, charge })).toBe('unclear');
    expect([charges, executed.length]).toEqual([1, 1]);
  });

  it('the startup parse still refuses on and returns only off', () => {
    expect(parseConsentAnswerConfig({}).classifier).toBe('off');
    expect(() => parseConsentAnswerConfig({ QUOKY_CONSENT_ANSWER_CLASSIFIER: 'on' })).toThrow();
  });
});

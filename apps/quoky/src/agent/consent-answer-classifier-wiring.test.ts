import { describe, expect, it } from 'vitest';
import { Capability, type AiProvider } from '@quoky/core';
import { buildConsentClassifierSwitch } from './consent-answer-classifier-wiring';
import { parseConsentAnswerConfig } from './consent-answer-config';

// A6 classifier wiring: the composition root builds the switch from config. `off` is exactly the old hard-wired value and touches
// no router; `on` (refused at startup until A6-S4) builds the adapter, which is `unclear` without the turn's chat provider.

describe('buildConsentClassifierSwitch', () => {
  it('off (and unset) is { mode: "off" } and never touches the router', () => {
    const router = { select: async (): Promise<AiProvider> => { throw new Error('router must not be used'); } };
    expect(buildConsentClassifierSwitch('off', router, () => 0)).toEqual({ mode: 'off' });
    expect(buildConsentClassifierSwitch(undefined, router, () => 0)).toEqual({ mode: 'off' });
  });

  it('on builds the adapter; with no chat provider fact it answers `unclear` without a call (fail closed)', async () => {
    const selected: Capability[] = [];
    const router = { select: async (capability: Capability): Promise<AiProvider> => { selected.push(capability); throw new Error('no provider'); } };
    const built = buildConsentClassifierSwitch('on', router, () => 0);
    expect(built.mode).toBe('on');
    if (built.mode !== 'on') throw new Error('unreachable');
    expect(await built.classify({ question: '보낼까요?', reply: '그래' })).toBe('unclear');
    expect(selected).toEqual([]);
  });

  it('the startup parse still refuses on and returns only off', () => {
    expect(parseConsentAnswerConfig({}).classifier).toBe('off');
    expect(() => parseConsentAnswerConfig({ QUOKY_CONSENT_ANSWER_CLASSIFIER: 'on' })).toThrow();
  });
});

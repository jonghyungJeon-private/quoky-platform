import { describe, expect, it } from 'vitest';
import { ConsentAnswerConfigError, parseConsentAnswerConfig } from './consent-answer-config';
import { QuokyConfigErrorCode, loadConfig } from '../config';
import { describeStartupFailure } from '../bootstrap-preflight';

// ADR-0121 amendment A6, slice A6-S1: QUOKY_CONSENT_ANSWER_CLASSIFIER, default off; `on` refused until A6-S2, the A6-S4
// gate and the rule-① confirm slice (R10).

function failureOf(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('parseConsentAnswerConfig', () => {
  it('defaults to off; exactly off is accepted', () => {
    expect(parseConsentAnswerConfig({})).toEqual({ classifier: 'off' });
    expect(parseConsentAnswerConfig({ QUOKY_CONSENT_ANSWER_CLASSIFIER: 'off' })).toEqual({ classifier: 'off' });
  });

  it('on fails startup with the release-gate code and a value-free hint', () => {
    const error = failureOf(() => parseConsentAnswerConfig({ QUOKY_CONSENT_ANSWER_CLASSIFIER: 'on' }));
    expect(error).toBeInstanceOf(ConsentAnswerConfigError);
    expect((error as ConsentAnswerConfigError).code).toBe('CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED');
    const failure = describeStartupFailure(error);
    expect(failure.message).toBe('CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED');
    expect(failure.hint).toContain('QUOKY_CONSENT_ANSWER_CLASSIFIER');
  });

  it.each(['', 'ON', 'Off', ' off', 'true', 'shadow', 'on,off'])('refuses %j exactly (CONSENT_ANSWER_CLASSIFIER_INVALID), never echoing the value', (value) => {
    const error = failureOf(() => parseConsentAnswerConfig({ QUOKY_CONSENT_ANSWER_CLASSIFIER: value }));
    expect((error as ConsentAnswerConfigError).code).toBe('CONSENT_ANSWER_CLASSIFIER_INVALID');
    expect((error as Error).message).toBe('CONSENT_ANSWER_CLASSIFIER_INVALID');
    const hint = describeStartupFailure(error).hint ?? '';
    expect(hint).toContain('QUOKY_CONSENT_ANSWER_CLASSIFIER');
    // The hint is fixed text (it names the allowed value "off"); it never carries the refused value.
    expect(hint).toBe('QUOKY_CONSENT_ANSWER_CLASSIFIER must be unset (off) or "off" (exactly, lowercase).');
  });

  it('its codes are QuokyConfig error codes, and loadConfig folds it in (default off; a typo stops startup)', () => {
    expect(QuokyConfigErrorCode.CONSENT_ANSWER_CLASSIFIER_INVALID).toBe('CONSENT_ANSWER_CLASSIFIER_INVALID');
    expect(QuokyConfigErrorCode.CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED).toBe('CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED');
    const owner = { QUOKY_DISCORD_OWNER_IDS: '111111111111111111' };
    expect(loadConfig(owner).consentAnswer).toEqual({ classifier: 'off' });
    expect(() => loadConfig({ ...owner, QUOKY_CONSENT_ANSWER_CLASSIFIER: 'on' })).toThrow('CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED');
    expect(() => loadConfig({ ...owner, QUOKY_CONSENT_ANSWER_CLASSIFIER: 'yes' })).toThrow('CONSENT_ANSWER_CLASSIFIER_INVALID');
  });
});

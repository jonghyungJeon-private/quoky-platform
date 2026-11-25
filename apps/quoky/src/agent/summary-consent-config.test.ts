import { describe, expect, it } from 'vitest';
import { SummaryConsentConfigError, parseSummaryConsentConfig } from './summary-consent-config';
import { QuokyConfigErrorCode, loadConfig } from '../config';
import { describeStartupFailure } from '../bootstrap-preflight';

// ADR-0121 SR-1 rule ① (confirm slice CS-1a): QUOKY_SUMMARY_CONSENT, off by default, `on` exact, anything else stops startup.

function failureOf(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('parseSummaryConsentConfig', () => {
  it('defaults to off; off and on are accepted exactly', () => {
    expect(parseSummaryConsentConfig({})).toEqual({ mode: 'off' });
    expect(parseSummaryConsentConfig({ QUOKY_SUMMARY_CONSENT: 'off' })).toEqual({ mode: 'off' });
    expect(parseSummaryConsentConfig({ QUOKY_SUMMARY_CONSENT: 'on' })).toEqual({ mode: 'on' });
  });

  it.each(['', 'ON', 'On', 'Off', ' on', 'on ', 'true', '1', 'shadow', 'on,off'])('refuses %j exactly (SUMMARY_CONSENT_INVALID), never echoing the value', (value) => {
    const error = failureOf(() => parseSummaryConsentConfig({ QUOKY_SUMMARY_CONSENT: value }));
    expect(error).toBeInstanceOf(SummaryConsentConfigError);
    expect((error as SummaryConsentConfigError).code).toBe('SUMMARY_CONSENT_INVALID');
    expect((error as Error).message).toBe('SUMMARY_CONSENT_INVALID');
    const failure = describeStartupFailure(error);
    expect(failure.message).toBe('SUMMARY_CONSENT_INVALID');
    // The hint is fixed text naming the allowed values; it never carries the refused value.
    expect(failure.hint).toBe('QUOKY_SUMMARY_CONSENT must be unset (off), "off" or "on" (exactly, lowercase).');
  });

  it('its code is a QuokyConfig error code, and loadConfig folds it in (default off; a typo stops startup)', () => {
    expect(QuokyConfigErrorCode.SUMMARY_CONSENT_INVALID).toBe('SUMMARY_CONSENT_INVALID');
    const owner = { QUOKY_DISCORD_OWNER_IDS: '111111111111111111' };
    expect(loadConfig(owner).summaryConsent).toEqual({ mode: 'off' });
    expect(loadConfig({ ...owner, QUOKY_SUMMARY_CONSENT: 'on' }).summaryConsent).toEqual({ mode: 'on' });
    expect(() => loadConfig({ ...owner, QUOKY_SUMMARY_CONSENT: 'yes' })).toThrow('SUMMARY_CONSENT_INVALID');
  });
});

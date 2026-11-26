import { describe, expect, it } from 'vitest';
import { SummaryConsentConfigError, parseItemSummaryConsentConfig, parseSummaryConsentConfig } from './summary-consent-config';
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

// ADR-0121 amendment A8 (OQ1-2): QUOKY_ITEM_SUMMARY_CONSENT, off by default, `on` exact and only with QUOKY_SUMMARY_CONSENT=on.
describe('parseItemSummaryConsentConfig', () => {
  const on = { mode: 'on' } as const;
  const off = { mode: 'off' } as const;

  it('defaults to off (also with QUOKY_SUMMARY_CONSENT=on); on needs QUOKY_SUMMARY_CONSENT=on', () => {
    expect(parseItemSummaryConsentConfig({}, off)).toEqual({ mode: 'off' });
    expect(parseItemSummaryConsentConfig({}, on)).toEqual({ mode: 'off' });
    expect(parseItemSummaryConsentConfig({ QUOKY_ITEM_SUMMARY_CONSENT: 'off' }, on)).toEqual({ mode: 'off' });
    expect(parseItemSummaryConsentConfig({ QUOKY_ITEM_SUMMARY_CONSENT: 'on' }, on)).toEqual({ mode: 'on' });
  });

  it.each(['', 'ON', 'On', ' on', 'on ', 'true', '1', 'shadow'])('refuses %j exactly (ITEM_SUMMARY_CONSENT_INVALID), never echoing the value', (value) => {
    const error = failureOf(() => parseItemSummaryConsentConfig({ QUOKY_ITEM_SUMMARY_CONSENT: value }, on));
    expect(error).toBeInstanceOf(SummaryConsentConfigError);
    expect((error as Error).message).toBe('ITEM_SUMMARY_CONSENT_INVALID');
    const failure = describeStartupFailure(error);
    expect(failure.message).toBe('ITEM_SUMMARY_CONSENT_INVALID');
    expect(failure.hint).toBe('QUOKY_ITEM_SUMMARY_CONSENT must be unset (off), "off" or "on" (exactly, lowercase).');
  });

  it('on without QUOKY_SUMMARY_CONSENT=on stops startup (ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT; precedent NL_ITEM_R2_REQUIRES_ACTIONS)', () => {
    const error = failureOf(() => parseItemSummaryConsentConfig({ QUOKY_ITEM_SUMMARY_CONSENT: 'on' }, off));
    expect((error as SummaryConsentConfigError).code).toBe('ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT');
    expect(describeStartupFailure(error).hint).toBe('QUOKY_ITEM_SUMMARY_CONSENT=on needs QUOKY_SUMMARY_CONSENT=on.');
  });

  it('loadConfig folds it in: default off, on with both switches, either refusal stops startup', () => {
    expect(QuokyConfigErrorCode.ITEM_SUMMARY_CONSENT_INVALID).toBe('ITEM_SUMMARY_CONSENT_INVALID');
    expect(QuokyConfigErrorCode.ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT).toBe('ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT');
    const owner = { QUOKY_DISCORD_OWNER_IDS: '111111111111111111' };
    expect(loadConfig(owner).itemSummaryConsent).toEqual({ mode: 'off' });
    expect(loadConfig({ ...owner, QUOKY_SUMMARY_CONSENT: 'on' }).itemSummaryConsent).toEqual({ mode: 'off' });
    expect(loadConfig({ ...owner, QUOKY_SUMMARY_CONSENT: 'on', QUOKY_ITEM_SUMMARY_CONSENT: 'on' }).itemSummaryConsent).toEqual({ mode: 'on' });
    expect(() => loadConfig({ ...owner, QUOKY_ITEM_SUMMARY_CONSENT: 'on' })).toThrow('ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT');
    expect(() => loadConfig({ ...owner, QUOKY_SUMMARY_CONSENT: 'on', QUOKY_ITEM_SUMMARY_CONSENT: 'yes' })).toThrow('ITEM_SUMMARY_CONSENT_INVALID');
  });
});

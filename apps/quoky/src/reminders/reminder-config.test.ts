import { describe, expect, it } from 'vitest';
import { ReminderConfigError, ReminderConfigErrorCode, parseReminderConfig } from './reminder-config';

const env = (overrides: Record<string, string>): NodeJS.ProcessEnv => overrides as NodeJS.ProcessEnv;

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ReminderConfigError);
    expect((err as ReminderConfigError).message).toBe((err as ReminderConfigError).code);
    return (err as ReminderConfigError).code;
  }
  return undefined;
}

describe('parseReminderConfig', () => {
  it('defaults to enabled (ADR-0102 D9, owner decision 8), DM-only delivery and Asia/Seoul', () => {
    expect(parseReminderConfig(env({}))).toEqual({ enabled: true, channelDelivery: false, timeZone: 'Asia/Seoul' });
  });

  it('accepts exact true/false and an IANA zone', () => {
    expect(
      parseReminderConfig(
        env({ QUOKY_REMINDERS_ENABLED: 'true', QUOKY_REMINDERS_CHANNEL_DELIVERY: 'true', QUOKY_TIMEZONE: 'Europe/Berlin' }),
      ),
    ).toEqual({ enabled: true, channelDelivery: true, timeZone: 'Europe/Berlin' });
    expect(parseReminderConfig(env({ QUOKY_REMINDERS_ENABLED: 'false', QUOKY_REMINDERS_CHANNEL_DELIVERY: 'false' }))).toMatchObject({
      enabled: false,
      channelDelivery: false,
    });
  });

  it('canonicalizes the zone spelling through Intl', () => {
    expect(parseReminderConfig(env({ QUOKY_TIMEZONE: 'asia/seoul' })).timeZone).toBe('Asia/Seoul');
  });

  it.each(['', 'TRUE', 'True', '1', '0', 'yes', 'on', ' true', 'true '])('rejects non-exact boolean %j', (value) => {
    expect(codeOf(() => parseReminderConfig(env({ QUOKY_REMINDERS_ENABLED: value })))).toBe(
      ReminderConfigErrorCode.REMINDERS_ENABLED_INVALID,
    );
    expect(codeOf(() => parseReminderConfig(env({ QUOKY_REMINDERS_CHANNEL_DELIVERY: value })))).toBe(
      ReminderConfigErrorCode.REMINDERS_CHANNEL_DELIVERY_INVALID,
    );
  });

  it.each(['', 'Not/AZone', 'Mars/Olympus', '+09:00', 'GMT+9 ', 'Asia Seoul', '../etc/passwd', 'A'.repeat(65)])(
    'rejects invalid zone %j with a value-free error',
    (value) => {
      expect(codeOf(() => parseReminderConfig(env({ QUOKY_TIMEZONE: value })))).toBe(ReminderConfigErrorCode.TIMEZONE_INVALID);
    },
  );
});

/**
 * Reminder configuration (ADR-0096 D9 / ADR-0101). Parsed once here; nothing consumes it until the reminder
 * track (PRO) wires it. Parsing a variable authorizes no behaviour. Exact `true`/`false` only, safe inert
 * defaults, typed value-free errors (the message is the code only; a configured value is never echoed).
 *
 * The error type lives here, not in `config.ts`, so `config.ts` can import this module without an import cycle;
 * `config.ts` re-exposes these codes through `QuokyConfigErrorCode` so startup hints cover them.
 */
export interface ReminderConfig {
  /** `QUOKY_REMINDERS_ENABLED`, default false. */
  enabled: boolean;
  /**
   * `QUOKY_REMINDERS_CHANNEL_DELIVERY`, default false (owner DM only). Inert while reminders are off. When true,
   * members of the allowlisted channel can read reminder text (ADR-0101 D8).
   */
  channelDelivery: boolean;
  /** `QUOKY_TIMEZONE`, an IANA zone validated through `Intl`, default `Asia/Seoul`. */
  timeZone: string;
}

export const DEFAULT_REMINDER_TIME_ZONE = 'Asia/Seoul';

export const ReminderConfigErrorCode = {
  REMINDERS_ENABLED_INVALID: 'REMINDERS_ENABLED_INVALID',
  REMINDERS_CHANNEL_DELIVERY_INVALID: 'REMINDERS_CHANNEL_DELIVERY_INVALID',
  TIMEZONE_INVALID: 'TIMEZONE_INVALID',
} as const;
export type ReminderConfigErrorCode = (typeof ReminderConfigErrorCode)[keyof typeof ReminderConfigErrorCode];

/** A fail-closed startup configuration error. The message is the code only (no configured value). */
export class ReminderConfigError extends Error {
  constructor(readonly code: ReminderConfigErrorCode) {
    super(code);
    this.name = 'ReminderConfigError';
  }
}

const MAX_TIME_ZONE_CHARACTERS = 64;
/** IANA-shaped names only (`Area/Location`, `UTC`); rejects offset forms such as `+09:00` that `Intl` may accept. */
const IANA_TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*)*$/;

export function parseReminderConfig(env: NodeJS.ProcessEnv): ReminderConfig {
  return {
    enabled: parseBoolean(env.QUOKY_REMINDERS_ENABLED, ReminderConfigErrorCode.REMINDERS_ENABLED_INVALID),
    channelDelivery: parseBoolean(
      env.QUOKY_REMINDERS_CHANNEL_DELIVERY,
      ReminderConfigErrorCode.REMINDERS_CHANNEL_DELIVERY_INVALID,
    ),
    timeZone: parseTimeZone(env.QUOKY_TIMEZONE),
  };
}

/** Exact `true`/`false`; unset is the inert default `false`. Anything else (including empty) is a startup error. */
function parseBoolean(raw: string | undefined, error: ReminderConfigErrorCode): boolean {
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ReminderConfigError(error);
}

/** Unset yields `Asia/Seoul`. A set value must be a valid IANA zone; the canonical `Intl` spelling is returned. */
function parseTimeZone(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_REMINDER_TIME_ZONE;
  if (raw.length === 0 || raw.length > MAX_TIME_ZONE_CHARACTERS || !IANA_TIME_ZONE_SHAPE.test(raw)) {
    throw new ReminderConfigError(ReminderConfigErrorCode.TIMEZONE_INVALID);
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    throw new ReminderConfigError(ReminderConfigErrorCode.TIMEZONE_INVALID);
  }
}

/**
 * Log and ledger timestamps (ADR-0121 S0, MSIT ⑤-2): ISO-8601 in the host's local time with an explicit numeric
 * offset, e.g. `2026-10-13T09:35:12.345+09:00`, so a line can be compared with the security team's KST records
 * without guessing the zone. Pure functions of a `Date`; callers pass the shared clock's time.
 */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DDTHH:mm:ss.sss±HH:MM` in the host's local time zone. */
export function isoWithOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return (
    `${localDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/** The host-local calendar date `YYYY-MM-DD` (the ledger's daily file key). */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

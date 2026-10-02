/**
 * Proactive owner reminders (ADR-0101) — application sub-barrel.
 *
 * The track's tasks (first: PRO-1) add their modules to this folder and export them from this sub-barrel only;
 * the root application barrel is not edited after wave 1. PRO-1: pure zoned time, schedule arithmetic with the
 * missed-reminder policy, and the deterministic KO/EN reminder grammar.
 */
export * from './zoned-time';
export * from './reminder-schedule';
export * from './reminder-grammar';

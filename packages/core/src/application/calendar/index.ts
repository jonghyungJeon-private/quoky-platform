/**
 * Calendar schedule questions (ADR-0110 D3–D6, plan CAL-2) — application sub-barrel: the pure KO/EN question grammar
 * and window placement, the deterministic reply renderer, and the `pre-classify` turn handler (order 150). The port is
 * `CalendarReader` (CAL-1); the composition root registers the handler only when a reader is configured
 * (`apps/quoky/src/features/calendar.providers.ts`).
 */
export * from './calendar-question';
export * from './calendar-reply-renderer';
export * from './calendar-turn-handler';

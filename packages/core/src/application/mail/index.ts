/**
 * The owner's mail, read-only (ADR-0118, plan GML-1) — application sub-barrel: the pure anchored mail grammar, the
 * deterministic reply renderer and the `pre-classify` turn handler (order 140). The port is `MailReader`; the
 * composition root registers the handler only when Gmail is configured (`apps/quoky/src/features/mail.providers.ts`).
 */
export * from './mail-question';
export * from './mail-reply-renderer';
export * from './mail-turn-handler';

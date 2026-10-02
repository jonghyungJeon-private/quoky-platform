/**
 * Chat-usable work integrations (ADR-0100) — application sub-barrel.
 *
 * The track's tasks add their modules to this folder and export them from this sub-barrel only; the root application
 * barrel is not edited after wave 1. WORK-T3: the deterministic work grammar, the bounded untrusted external-work
 * readout, the Korean renderer and `WorkChatService` (the `WorkDesk`). Pure Core: no runtime, provider or app wiring.
 */
export * from './work-chat-command';
export * from './external-work-readout';
export * from './work-chat-renderer';
export * from './work-chat-service';

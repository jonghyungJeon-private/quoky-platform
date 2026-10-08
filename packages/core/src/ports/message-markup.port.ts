import type { PlatformNoteTopic, UntrustedTextGuard } from '../domain';

/**
 * PORT (PLT-0, ARCHITECTURE.md §3): how one chat platform writes the spans of platform-neutral message content
 * (`domain/message-content.ts`) whose presentation is platform-specific. Each platform adapter package implements it
 * for its own platform; Core evaluates the content and the layout budgets against it
 * (`application/message-rendering.ts`, `renderMessageContent`). No DI token: an adapter passes its markup to the
 * evaluator when it renders a message.
 *
 * Every method returns text in the platform's own parse mode, so untrusted text MUST come back neutralized for it.
 */
export interface MessageMarkup {
  /** Untrusted text, neutralized as `guard` requires (formatting, mentions, links). */
  untrusted(text: string, guard: UntrustedTextGuard): string;
  /** A URL shown as a plain link, without an embed or preview card. */
  link(url: string): string;
  /** A reference to a platform conversation, by opaque id. */
  conversation(id: string): string;
  /** The platform's own advice on a neutral topic, or `''`. */
  platformNote(topic: PlatformNoteTopic): string;
}

import { plainTextOf, renderMessageContent } from '@quoky/core';
import type { ConversationRefNode, MessageBody, MessageMarkup, OutboundMessage, PreviewArtifact } from '@quoky/core';
import { translateCommonMark, translateTelegramBody } from './commonmark';

/**
 * The single place where a domain message becomes Telegram text (ADR-0114 D7; the PLT-0 `MessageMarkup` port).
 *
 * Parse mode: NONE (plain text) for every message. Telegram then interprets no markup at all, so every node — Quoky's
 * CommonMark string nodes (and the untrusted text they may carry inside a fence), untrusted spans under every guard,
 * links and conversation references — is delivered verbatim and cannot format, link-mask or inject anything. That is
 * what "escape every string node for the parse mode" means for plain text: the identity.
 *
 * TG-3: Quoky's own copy and a model reply are CommonMark, so before sending, their markers are translated to plain text
 * (`commonmark.ts`: emphasis and code-span markers removed, fence lines removed with the content kept, headings as plain
 * lines, bullets as `•`). Untrusted spans, links and conversation references are opaque to the translation and are
 * delivered exactly as rendered.
 *
 * The one exception is the code-change preview's diff parts (`delivery.ts`): a fixed HTML subset, `<pre>` only, written
 * by the adapter around content passed through {@link escapeTelegramHtml}. No other HTML is ever produced.
 */

/** The platform id this adapter puts on every `ConversationContext` it builds. */
export const TELEGRAM_PLATFORM = 'telegram';

/**
 * A conversation reference. Telegram plain text has no native chat-link syntax, so a Telegram conversation is Quoky's
 * same-platform label ("이 DM"); a conversation on another platform is a neutral name of that platform's conversation,
 * never its native syntax (`<#id>`) or a bare id.
 */
function conversation(ref: ConversationRefNode): string {
  if (ref.platform === TELEGRAM_PLATFORM) return ref.label;
  const name = `${ref.platform.charAt(0).toUpperCase()}${ref.platform.slice(1)}`;
  return ref.direct ? `${name} 개인 대화` : `${name} 대화방`;
}

/** How Telegram (plain text, no parse mode) writes each platform-rendered span of the neutral content. */
export const TELEGRAM_MARKUP: MessageMarkup = Object.freeze({
  // No parse mode: nothing in the text is interpreted, under every guard.
  untrusted: (text: string) => text,
  // The link preview is disabled on every send (`link_preview_options.is_disabled`), the plain-text form of "no embed".
  link: (url: string) => url,
  conversation,
  // Telegram sends a "/"-prefixed phrase as typed; no platform advice is needed.
  platformNote: () => '',
});

/** The Telegram text of a neutral body: rendered with the Telegram markup, then its CommonMark translated (TG-3). */
export function renderTelegramContent(body: MessageBody): string {
  return translateTelegramBody(body, TELEGRAM_MARKUP, renderMessageContent(body, TELEGRAM_MARKUP));
}

/**
 * The Telegram text of an outbound message or notification: its neutral `content` rendered with the Telegram markup,
 * else its `text` (Quoky copy alone, or a `model-reply` answer), translated either way (TG-3).
 */
export function renderOutboundForTelegram(message: Pick<OutboundMessage, 'text' | 'content'>): string {
  return renderTelegramContent(message.content !== undefined ? message.content : message.text);
}

/** TG-3: Quoky copy given as a plain string (a preview header, warning or footer) as Telegram plain text. */
export function translateTelegramCopy(text: string): string {
  return translateCommonMark([{ text, span: false }]);
}

/**
 * TG-3: a code-change preview with its Quoky copy (header, warning, footer) translated. The canonical diff, the
 * attachment name and every other field are kept exactly (the diff goes in `<pre>` parts or the `.diff` document).
 */
export function translatePreviewCopy(preview: PreviewArtifact): PreviewArtifact {
  return {
    ...preview,
    header: translateTelegramCopy(preview.header),
    footer: translateTelegramCopy(preview.footer),
    ...(preview.warning !== undefined ? { warning: translateTelegramCopy(preview.warning) } : {}),
  };
}

/** Whether a message's `content` and `text` disagree (the PLT-0 review P3-1 check, as on Discord). */
export function contentDisagreesWithText(message: Pick<OutboundMessage, 'text' | 'content'>): boolean {
  return message.content !== undefined && plainTextOf(message.content) !== message.text;
}

/** HTML-escape for Telegram's HTML parse mode: `&`, `<`, `>` and `"` (every other character is literal there). */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

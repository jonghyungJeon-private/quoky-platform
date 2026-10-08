import type { OutboundMessage, OwnerNotification } from '@quoky/core';
import { renderMarkdownTablesForDiscord } from './markdown-tables';

/**
 * The single place where a domain message becomes the exact Discord message text (before chunking). Every send path
 * (`sendMessage`, owner notifications) renders through here, so the Discord bytes of a reply are a pure function of the
 * domain message and can be pinned by golden fixtures.
 */

/**
 * The Discord text of an outbound message. Discord renders no Markdown tables, so only a provider-generated reply the
 * runtime flagged `model-reply` is adapted (simple tables become lines); every other message is sent as given.
 */
export function renderOutboundForDiscord(message: Pick<OutboundMessage, 'text' | 'format'>): string {
  return message.format === 'model-reply' ? renderMarkdownTablesForDiscord(message.text) : message.text;
}

/** The Discord text of an owner notification (reminder, brief, operations notice). */
export function renderNotificationForDiscord(notification: Pick<OwnerNotification, 'text'>): string {
  return notification.text;
}

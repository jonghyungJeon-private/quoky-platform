import { plainTextOf, renderMessageContent } from '@quoky/core';
import type {
  ConversationRefNode,
  MessageBody,
  MessageMarkup,
  OutboundMessage,
  OwnerNotification,
  PlatformNoteTopic,
  UntrustedTextGuard,
} from '@quoky/core';
import { renderMarkdownTablesForDiscord } from './markdown-tables';

/**
 * The single place where a domain message becomes the exact Discord message text (before chunking). Every send path
 * (`sendMessage`, owner notifications) renders through here, so the Discord bytes of a reply are a pure function of the
 * domain message and are pinned by golden fixtures (`rendering-golden.test.ts`).
 *
 * PLT-0: Core emits platform-neutral content (`OutboundMessage.content`); the Discord markup of each neutral span lives
 * here and nowhere in Core.
 */

/** Zero-width space: placed after `@` / `<` it keeps Discord from parsing a mention, a channel or a link. */
const ZWSP = '\u200b';

/** Discord Markdown and quote characters an untrusted span must not be able to use. */
const DISCORD_MARKDOWN = /[\\*_~`|>[\]]/g;

function neutralize(text: string, guard: UntrustedTextGuard): string {
  switch (guard) {
    case 'markup':
      // Formatting, `@everyone`/`@here`/`<@id>` mentions, `<#id>` channels and `<url>` / masked links.
      return text.replace(DISCORD_MARKDOWN, '\\$&').replace(/@/g, `@${ZWSP}`).replace(/</g, `<${ZWSP}`);
    case 'mentions':
      // Only what could notify someone: the broadcast mentions and raw user/role mention syntax.
      return text.replace(/@(?=everyone|here)/gi, `@${ZWSP}`).replace(/<@/g, `<${ZWSP}@`);
    case 'handles':
      return text.replace(/@/gu, `@${ZWSP}`);
  }
}

const PLATFORM_NOTES: Readonly<Record<PlatformNoteTopic, string>> = {
  // Discord opens its application-command picker on a leading "/"; the help reply says how to send the phrase.
  'command-prefix': ' 다만 Discord에서는 "/"로 시작하면 명령 선택 창이 열리니, Esc로 창을 닫은 뒤 Enter로 보내 주세요.',
};

/** The platform id this adapter puts on every `ConversationContext` it builds. */
export const DISCORD_PLATFORM = 'discord';

/**
 * A conversation reference. `<#id>` only for a Discord channel or thread with a referenceable id; Quoky's label for a
 * Discord DM or an unreferenceable channel; for a conversation on another platform, a neutral name of that platform's
 * conversation, so a Discord message never calls it "이 DM" or writes Discord syntax for it.
 */
function conversation(ref: ConversationRefNode): string {
  if (ref.platform === DISCORD_PLATFORM) return ref.id !== undefined ? `<#${ref.id}>` : ref.label;
  const name = `${ref.platform.charAt(0).toUpperCase()}${ref.platform.slice(1)}`;
  return ref.direct ? `${name} 개인 대화` : `${name} 대화방`;
}

/** How Discord writes each platform-rendered span of the neutral content. */
export const DISCORD_MARKUP: MessageMarkup = Object.freeze({
  untrusted: neutralize,
  // Angle brackets suppress Discord's link embed.
  link: (url: string) => `<${url}>`,
  conversation,
  platformNote: (topic: PlatformNoteTopic) => PLATFORM_NOTES[topic],
});

/** The Discord text of a neutral body. */
export function renderDiscordContent(body: MessageBody): string {
  return renderMessageContent(body, DISCORD_MARKUP);
}

/**
 * The Discord text of an outbound message: its neutral `content` rendered with the Discord markup (else its `text`).
 * Discord renders no Markdown tables, so only a provider-generated reply the runtime flagged `model-reply` is adapted
 * (simple tables become lines); every other message is sent as rendered.
 */
export function renderOutboundForDiscord(message: Pick<OutboundMessage, 'text' | 'format' | 'content'>): string {
  const text = message.content !== undefined ? renderDiscordContent(message.content) : message.text;
  return message.format === 'model-reply' ? renderMarkdownTablesForDiscord(text) : text;
}

/** The Discord text of an owner notification (reminder, brief, operations notice). */
export function renderNotificationForDiscord(notification: Pick<OwnerNotification, 'text' | 'content'>): string {
  return notification.content !== undefined ? renderDiscordContent(notification.content) : notification.text;
}

/**
 * Whether a message's `content` and `text` disagree (review P3-1): Core rewrote `text` without `content` (or the
 * reverse). The adapter still renders `content` — the safe choice — and logs a content-free warning so the producer can
 * be found.
 */
export function contentDisagreesWithText(message: Pick<OutboundMessage, 'text' | 'content'>): boolean {
  return message.content !== undefined && plainTextOf(message.content) !== message.text;
}

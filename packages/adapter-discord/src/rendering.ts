import { renderMessageContent } from '@quoky/core';
import type { MessageBody, MessageMarkup, OutboundMessage, OwnerNotification, PlatformNoteTopic, UntrustedTextGuard } from '@quoky/core';
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

/** How Discord writes each platform-rendered span of the neutral content. */
export const DISCORD_MARKUP: MessageMarkup = Object.freeze({
  untrusted: neutralize,
  // Angle brackets suppress Discord's link embed.
  link: (url: string) => `<${url}>`,
  conversation: (id: string) => `<#${id}>`,
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

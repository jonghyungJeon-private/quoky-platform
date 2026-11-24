import { renderMessageContent } from '@quoky/core';
import type { ConversationRefNode, MessageBody, MessageMarkup, OutboundMessage } from '@quoky/core';

import { LOCAL_CLIENT_PLATFORM } from './constants';

/**
 * ADR-0125 D4 / ADR-0114 D1: the adapter renders the PLT-0 neutral content its own way: plain text plus typed spans.
 * The app shows every span as plain text; `untrusted` and `link` spans stay marked, and a link is data the app may show
 * but never opens on its own. Nothing here parses or produces markup.
 */

export type ReplySpanType = 'text' | 'untrusted' | 'link' | 'conversation';
export interface ReplySpan {
  readonly type: ReplySpanType;
  readonly text: string;
}

export interface RenderedReply {
  /** The plain text of the whole reply. */
  readonly text: string;
  /** The same text as typed spans; their concatenation equals `text`. */
  readonly content: readonly ReplySpan[];
}

// Private-use delimiters mark spans during one render pass; any such character in an input is removed first.
const OPEN = '';
const SEP = '';
const CLOSE = '';
const DELIMITERS = /[-]/g;
const SPAN_PATTERN = /([a-z]+)([^-]*)/g;

function conversation(ref: ConversationRefNode): string {
  if (ref.platform === LOCAL_CLIENT_PLATFORM) return ref.label;
  const name = `${ref.platform.charAt(0).toUpperCase()}${ref.platform.slice(1)}`;
  return ref.direct ? `${name} 개인 대화` : `${name} 대화방`;
}

const plainMarkup: MessageMarkup = Object.freeze({
  untrusted: (text: string) => text,
  link: (url: string) => url,
  conversation,
  platformNote: () => '',
});

const spanMarkup: MessageMarkup = Object.freeze({
  untrusted: (text: string) => `${OPEN}untrusted${SEP}${text.replace(DELIMITERS, '')}${CLOSE}`,
  link: (url: string) => `${OPEN}link${SEP}${url.replace(DELIMITERS, '')}${CLOSE}`,
  conversation: (ref: ConversationRefNode) => `${OPEN}conversation${SEP}${conversation(ref).replace(DELIMITERS, '')}${CLOSE}`,
  platformNote: () => '',
});

function spansOf(marked: string): ReplySpan[] {
  const spans: ReplySpan[] = [];
  let cursor = 0;
  for (const match of marked.matchAll(SPAN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) spans.push({ type: 'text', text: marked.slice(cursor, index) });
    spans.push({ type: match[1] as ReplySpanType, text: match[2] ?? '' });
    cursor = index + match[0].length;
  }
  if (cursor < marked.length) spans.push({ type: 'text', text: marked.slice(cursor) });
  return spans.filter((span) => span.text.length > 0);
}

export function renderReply(message: Pick<OutboundMessage, 'text' | 'content'>): RenderedReply {
  const body: MessageBody = message.content !== undefined ? message.content : message.text;
  const text = renderMessageContent(body, plainMarkup).replace(DELIMITERS, '');
  if (message.content === undefined) return { text, content: text.length === 0 ? [] : [{ type: 'text', text }] };
  const spans = spansOf(renderMessageContent(body, spanMarkup));
  // If a length budget cut differently under the marked pass, the typed view is not trustworthy: one plain span.
  return spans.map((span) => span.text).join('') === text ? { text, content: spans } : { text, content: text.length === 0 ? [] : [{ type: 'text', text }] };
}

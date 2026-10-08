/**
 * Platform-neutral message content (PLT-0; ARCHITECTURE.md §2.2 "the Core knows nothing concrete" for rendering).
 *
 * Core composes a reply from these nodes and each `PlatformAdapter` renders them to its own markup: escaping, mention
 * neutralization, link and conversation-reference syntax. `OutboundMessage.text` stays the PLAIN rendering of the
 * same content (conversation history, logs, adapters that do not read `content`).
 *
 * - A string node is Quoky's own copy, delivered as written. It may use the neutral CommonMark subset Core already
 *   writes (`**strong**`, `` `code` ``, fenced blocks), exactly like a provider's Markdown answer; an adapter for a
 *   platform without Markdown translates it. Text Quoky did not author is never a string node.
 * - `untrusted`, `link`, `conversation` and `platform-note` are the spans whose presentation is the platform's.
 * - `clip`, `fit-lines` and `take-lines` are length budgets. They are evaluated on the RENDERED text of the platform
 *   the message is delivered on, so a budget keeps exactly the lines that fit there (an escaped title is longer than
 *   its plain form) and the plain rendering applies the same rule to the plain text.
 */

/** How strictly an untrusted span is neutralized when rendered. */
export type UntrustedTextGuard =
  /** Formatting, mentions and links are all neutralized (external readouts, owner text echoed inline). */
  | 'markup'
  /** Only syntax that could notify someone is neutralized; formatting characters are kept as they are. */
  | 'mentions'
  /** Every `@` handle is neutralized and nothing else. */
  | 'handles';

/** Text Quoky did not author (a connector readout, a calendar title, a write payload, the owner's own words). */
export interface UntrustedTextNode {
  readonly kind: 'untrusted';
  readonly text: string;
  readonly guard: UntrustedTextGuard;
}

/** A URL the platform shows as a plain link, without an embed or a preview card. */
export interface LinkNode {
  readonly kind: 'link';
  readonly url: string;
}

/** A reference to a conversation (channel or thread) of the platform the message is delivered on, by its opaque id. */
export interface ConversationRefNode {
  readonly kind: 'conversation';
  readonly id: string;
}

/** A neutral topic on which a platform may add its own usage advice (or nothing). */
export type PlatformNoteTopic =
  /** Typing a `/`-prefixed control phrase on this platform. */
  'command-prefix';

export interface PlatformNoteNode {
  readonly kind: 'platform-note';
  readonly topic: PlatformNoteTopic;
}

/** How a budget counts characters: UTF-16 code units (`String.length`) or Unicode code points. */
export type MessageLengthUnit = 'utf16' | 'code-points';

/**
 * Clip the rendered `content` (trimmed first when `trim`) to `maxChars`, ending in `…`; the rendered `after` is kept
 * whole behind it and its length is reserved from the budget (nothing of `content` is kept when no room is left).
 */
export interface ClipNode {
  readonly kind: 'clip';
  readonly content: MessageContent;
  readonly maxChars: number;
  readonly unit: MessageLengthUnit;
  readonly trim?: boolean;
  readonly after?: MessageContent;
}

export interface FitLine {
  readonly content: MessageContent;
  /** May be left out (from the end first) when the lines do not fit. */
  readonly droppable?: boolean;
}

/**
 * Lines joined by `\n`, at most `maxChars` UTF-16 units: droppable lines leave from the end first (then
 * `omittedNote`, when given, closes the text), and a text that still does not fit is clipped, ending in `…`.
 */
export interface FitLinesNode {
  readonly kind: 'fit-lines';
  readonly lines: readonly FitLine[];
  readonly maxChars: number;
  readonly omittedNote?: string;
}

export interface TakeLine {
  readonly content: MessageContent;
  /** A list entry (counted when left out); other lines are headings. */
  readonly item?: boolean;
}

/**
 * `head` lines, then the leading `lines` that fit, then `tail` lines, joined by `\n`. The budget counts `baseChars`,
 * every `head` and `tail` line and each taken line plus one separator, and stops at the first line that does not fit.
 */
export interface TakeLinesNode {
  readonly kind: 'take-lines';
  readonly unit: MessageLengthUnit;
  readonly maxChars: number;
  readonly baseChars: number;
  readonly head: readonly MessageContent[];
  readonly tail: readonly MessageContent[];
  readonly lines: readonly TakeLine[];
  /** `head` is emitted only when at least one line was taken. */
  readonly headOnlyWithLines?: boolean;
  /** Taken trailing headings (non-items) are dropped, so the list never ends on a heading. */
  readonly dropTrailingHeadings?: boolean;
  /** When any item was left out: a closing line `${before}${count}${after}`, `count` = left-out items + `hidden`. */
  readonly omitted?: { readonly hidden: number; readonly before: string; readonly after: string };
}

export type MessageNode =
  | string
  | UntrustedTextNode
  | LinkNode
  | ConversationRefNode
  | PlatformNoteNode
  | ClipNode
  | FitLinesNode
  | TakeLinesNode;

/** A message (or a part of one) as platform-neutral nodes. Build it with `messageContent` and friends. */
export type MessageContent = readonly MessageNode[];

/** What a renderer returns: plain Quoky copy, or content that carries platform-rendered spans. */
export type MessageBody = string | MessageContent;

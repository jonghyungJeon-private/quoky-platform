import type {
  ClipNode,
  ConversationContext,
  ConversationRefNode,
  FitLine,
  FitLinesNode,
  LinkNode,
  MessageBody,
  MessageContent,
  MessageLengthUnit,
  MessageNode,
  OutboundMessage,
  PlatformNoteNode,
  PlatformNoteTopic,
  TakeLine,
  TakeLinesNode,
  UntrustedTextGuard,
  UntrustedTextNode,
} from '../domain';
import type { MessageMarkup } from '../ports/message-markup.port';

/**
 * Builders and the evaluator of the platform-neutral message content (PLT-0, `domain/message-content.ts`). Pure.
 *
 * A `PlatformAdapter` renders content with its own `MessageMarkup` (the port in `ports/message-markup.port.ts`); Core uses {@link PLAIN_TEXT_MARKUP} for
 * `OutboundMessage.text`. Layout nodes (`clip`, `fit-lines`, `take-lines`) are evaluated here, against the markup in
 * use, so every platform keeps exactly the lines that fit in ITS rendering.
 */

/** The plain rendering behind `OutboundMessage.text`: untrusted text verbatim, bare URLs, `#id` or the label, no notes. */
export const PLAIN_TEXT_MARKUP: MessageMarkup = Object.freeze({
  untrusted: (text: string) => text,
  link: (url: string) => url,
  conversation: (ref: ConversationRefNode) => (ref.id !== undefined ? `#${ref.id}` : ref.label),
  platformNote: () => '',
});

function refuseStringify(): never {
  throw new TypeError('MessageContent must be rendered (renderMessageContent / plainTextOf), not stringified');
}

/** Freeze a node list; string coercion throws, so content can never be interpolated into a reply by mistake. */
function sealed(nodes: MessageNode[]): MessageContent {
  Object.defineProperty(nodes, 'toString', { value: refuseStringify, enumerable: false });
  return Object.freeze(nodes);
}

/** Freeze one node the same way: interpolating a node (`${untrustedText(x)}`) throws instead of writing `[object Object]`. */
function sealNode<T extends object>(node: T): T {
  Object.defineProperty(node, 'toString', { value: refuseStringify, enumerable: false });
  return Object.freeze(node);
}

/** What the builders accept: a body, or a single node. */
export type MessagePart = MessageBody | Exclude<MessageNode, string>;

function isNodeList(part: MessagePart): part is MessageContent {
  return Array.isArray(part);
}

/** Flatten parts into one content, merging adjacent strings and dropping empty ones. */
export function messageContent(...parts: readonly MessagePart[]): MessageContent {
  const nodes: MessageNode[] = [];
  const push = (node: MessageNode): void => {
    if (typeof node === 'string') {
      if (node.length === 0) return;
      const last = nodes.length - 1;
      if (typeof nodes[last] === 'string') {
        nodes[last] = `${nodes[last] as string}${node}`;
        return;
      }
    }
    nodes.push(node);
  };
  for (const part of parts) {
    if (typeof part === 'string') push(part);
    else if (isNodeList(part)) for (const node of part) push(node);
    else push(part as MessageNode);
  }
  return sealed(nodes);
}

/** `parts` joined by `separator` (a newline by default). */
export function joinMessage(parts: readonly MessagePart[], separator = '\n'): MessageContent {
  const out: MessagePart[] = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(separator);
    out.push(part);
  });
  return messageContent(...out);
}

/**
 * The body of `parts`: their plain text when nothing in them is rendered per platform (Quoky copy alone, budgets
 * included, renders the same everywhere), else the content. Renderers return this, so a reply without untrusted spans
 * stays a plain string.
 */
export function messageBody(...parts: readonly MessagePart[]): MessageBody {
  const content = messageContent(...parts);
  return needsPlatformMarkup(content) ? content : plainTextOf(content);
}

/** {@link messageBody} of `parts` joined by `separator` (a newline by default). */
export function joinBody(parts: readonly MessagePart[], separator = '\n'): MessageBody {
  return messageBody(joinMessage(parts, separator));
}

export function untrustedText(text: string, guard: UntrustedTextGuard = 'markup'): UntrustedTextNode {
  return sealNode({ kind: 'untrusted', text, guard });
}

export function messageLink(url: string): LinkNode {
  return sealNode({ kind: 'link', url });
}

/** The same safe-id rule as everywhere a raw id reaches chat text: letters, digits, `_` and `-` only. */
const REFERENCEABLE_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/** Whether a context is a one-to-one conversation (the adapter's `direct`; for an older context, no `spaceId`). */
export function isDirectConversation(context: ConversationContext): boolean {
  return context.direct ?? context.spaceId === undefined;
}

/**
 * A reference to the conversation of `context`: its platform, whether it is direct, and (for a channel or thread with a
 * safe id) its id. `labels` is Quoky's copy for the same-platform case the markup cannot reference natively.
 */
export function conversationRefOf(
  context: ConversationContext,
  labels: { readonly direct: string; readonly channel: string },
): ConversationRefNode {
  const direct = isDirectConversation(context);
  const id = context.threadId ?? context.channelId;
  const referenceable = !direct && REFERENCEABLE_ID.test(id);
  return sealNode({
    kind: 'conversation',
    platform: context.platform,
    direct,
    ...(referenceable ? { id } : {}),
    label: direct ? labels.direct : labels.channel,
  });
}

export function platformNote(topic: PlatformNoteTopic): PlatformNoteNode {
  return sealNode({ kind: 'platform-note', topic });
}

function asContent(part: MessagePart): MessageContent {
  return isNodeList(part) ? part : messageContent(part);
}

export function clipMessage(
  content: MessagePart,
  maxChars: number,
  unit: MessageLengthUnit,
  options: { readonly trim?: boolean; readonly after?: MessagePart } = {},
): ClipNode {
  return sealNode({
    kind: 'clip',
    content: asContent(content),
    maxChars,
    unit,
    ...(options.trim ? { trim: true } : {}),
    ...(options.after !== undefined ? { after: asContent(options.after) } : {}),
  });
}

export function fitLines(
  lines: ReadonlyArray<{ readonly content: MessagePart; readonly droppable?: boolean }>,
  maxChars: number,
  omittedNote?: string,
): FitLinesNode {
  return sealNode({
    kind: 'fit-lines',
    lines: Object.freeze(lines.map((line): FitLine => Object.freeze({ content: asContent(line.content), ...(line.droppable ? { droppable: true } : {}) }))),
    maxChars,
    ...(omittedNote !== undefined ? { omittedNote } : {}),
  });
}

export function takeLines(spec: {
  readonly unit: MessageLengthUnit;
  readonly maxChars: number;
  readonly baseChars: number;
  readonly head: readonly MessagePart[];
  readonly tail: readonly MessagePart[];
  readonly lines: ReadonlyArray<{ readonly content: MessagePart; readonly item?: boolean }>;
  readonly headOnlyWithLines?: boolean;
  readonly dropTrailingHeadings?: boolean;
  readonly omitted?: TakeLinesNode['omitted'];
}): TakeLinesNode {
  return sealNode({
    kind: 'take-lines',
    unit: spec.unit,
    maxChars: spec.maxChars,
    baseChars: spec.baseChars,
    head: Object.freeze(spec.head.map(asContent)),
    tail: Object.freeze(spec.tail.map(asContent)),
    lines: Object.freeze(spec.lines.map((line): TakeLine => Object.freeze({ content: asContent(line.content), ...(line.item ? { item: true } : {}) }))),
    ...(spec.headOnlyWithLines ? { headOnlyWithLines: true } : {}),
    ...(spec.dropTrailingHeadings ? { dropTrailingHeadings: true } : {}),
    ...(spec.omitted ? { omitted: Object.freeze({ ...spec.omitted }) } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------------------------

function measure(text: string, unit: MessageLengthUnit): number {
  return unit === 'utf16' ? text.length : Array.from(text).length;
}

function head(text: string, count: number, unit: MessageLengthUnit): string {
  return unit === 'utf16' ? text.slice(0, count) : Array.from(text).slice(0, count).join('');
}

function renderClip(node: ClipNode, markup: MessageMarkup): string {
  const after = node.after ? render(node.after, markup) : '';
  const budget = node.maxChars - measure(after, node.unit);
  const rendered = render(node.content, markup);
  const text = node.trim ? rendered.trim() : rendered;
  if (measure(text, node.unit) <= budget) return `${text}${after}`;
  if (budget <= 0) return after;
  return `${head(text, budget - 1, node.unit)}…${after}`;
}

function renderFitLines(node: FitLinesNode, markup: MessageMarkup): string {
  const rendered = node.lines.map((line) => render(line.content, markup));
  const kept = rendered.map((_, index) => index);
  let dropped = false;
  const join = (): string => {
    const text = kept.map((index) => rendered[index] as string).join('\n');
    return dropped && node.omittedNote !== undefined ? `${text}\n${node.omittedNote}` : text;
  };
  while (join().length > node.maxChars) {
    let at = -1;
    for (let k = kept.length - 1; k >= 0; k -= 1) {
      if (node.lines[kept[k] as number]?.droppable) {
        at = k;
        break;
      }
    }
    if (at < 0) break;
    kept.splice(at, 1);
    dropped = true;
  }
  const text = join();
  return text.length <= node.maxChars ? text : `${text.slice(0, node.maxChars - 1)}…`;
}

function renderTakeLines(node: TakeLinesNode, markup: MessageMarkup): string {
  const heads = node.head.map((line) => render(line, markup));
  const tails = node.tail.map((line) => render(line, markup));
  let length = node.baseChars + [...heads, ...tails].reduce((sum, line) => sum + measure(line, node.unit), 0);
  const taken: Array<{ text: string; item: boolean }> = [];
  let omitted = node.omitted?.hidden ?? 0;
  for (const [index, line] of node.lines.entries()) {
    const text = render(line.content, markup);
    const size = measure(text, node.unit) + 1;
    if (length + size > node.maxChars) {
      omitted += node.lines.slice(index).filter((entry) => entry.item === true).length;
      break;
    }
    taken.push({ text, item: line.item === true });
    length += size;
  }
  if (node.dropTrailingHeadings) {
    while (taken.length > 0 && !(taken[taken.length - 1] as { item: boolean }).item) taken.pop();
  }
  const lines = taken.map((line) => line.text);
  if (node.omitted && omitted > 0) lines.push(`${node.omitted.before}${omitted}${node.omitted.after}`);
  const shownHead = node.headOnlyWithLines && taken.length === 0 ? [] : heads;
  return [...shownHead, ...lines, ...tails].join('\n');
}

function renderNode(node: MessageNode, markup: MessageMarkup): string {
  if (typeof node === 'string') return node;
  switch (node.kind) {
    case 'untrusted':
      return markup.untrusted(node.text, node.guard);
    case 'link':
      return markup.link(node.url);
    case 'conversation':
      return markup.conversation(node);
    case 'platform-note':
      return markup.platformNote(node.topic);
    case 'clip':
      return renderClip(node, markup);
    case 'fit-lines':
      return renderFitLines(node, markup);
    case 'take-lines':
      return renderTakeLines(node, markup);
  }
}

function render(content: MessageContent, markup: MessageMarkup): string {
  let text = '';
  for (const node of content) text += renderNode(node, markup);
  return text;
}

/** Render a body with one platform's markup (a string body is returned as it is). */
export function renderMessageContent(body: MessageBody, markup: MessageMarkup): string {
  return typeof body === 'string' ? body : render(body, markup);
}

/** The plain rendering of a body: what `OutboundMessage.text` and the conversation history carry. */
export function plainTextOf(body: MessageBody): string {
  return renderMessageContent(body, PLAIN_TEXT_MARKUP);
}

function nodeNeedsMarkup(node: MessageNode): boolean {
  if (typeof node === 'string') return false;
  switch (node.kind) {
    case 'clip':
      return node.content.some(nodeNeedsMarkup) || (node.after?.some(nodeNeedsMarkup) ?? false);
    case 'fit-lines':
      return node.lines.some((line) => line.content.some(nodeNeedsMarkup));
    case 'take-lines':
      return [...node.head, ...node.tail, ...node.lines.map((line) => line.content)].some((part) => part.some(nodeNeedsMarkup));
    default:
      return true;
  }
}

/** Whether a body carries a span a platform renders its own way (otherwise its plain text is the message). */
export function needsPlatformMarkup(body: MessageBody): boolean {
  return typeof body !== 'string' && body.some(nodeNeedsMarkup);
}

/**
 * The `text` / `content` pair of an outbound message or an owner notification for a body: `text` is the plain
 * rendering, and `content` is present only when the body carries a platform-rendered span.
 */
export function messageFields(body: MessageBody): { readonly text: string; readonly content?: MessageContent } {
  return needsPlatformMarkup(body) ? { text: plainTextOf(body), content: body as MessageContent } : { text: plainTextOf(body) };
}

/**
 * An outbound message for a body: `text` is the plain rendering, and `content` is attached only when the body carries
 * a platform-rendered span (a body of Quoky copy alone is just its text).
 */
export function outboundMessage(
  context: ConversationContext,
  body: MessageBody,
  extra: Omit<OutboundMessage, 'context' | 'text' | 'content'> = {},
): OutboundMessage {
  return withOutboundBody({ ...extra, context, text: '' }, body);
}

/** The body of an outbound message: its `content` when present, else its `text`. */
export function outboundBody(message: Pick<OutboundMessage, 'text' | 'content'>): MessageBody {
  return message.content ?? message.text;
}

/** The same message with a new body (other fields kept; a stale `content` is never left behind). */
export function withOutboundBody(message: OutboundMessage, body: MessageBody): OutboundMessage {
  const { content: _previous, ...rest } = message;
  return { ...rest, ...messageFields(body) };
}

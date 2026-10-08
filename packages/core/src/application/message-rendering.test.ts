import { describe, expect, it } from 'vitest';
import type { MessageMarkup } from '../ports/message-markup.port';
import {
  PLAIN_TEXT_MARKUP,
  clipMessage,
  conversationRefOf,
  isDirectConversation,
  fitLines,
  joinBody,
  joinMessage,
  messageBody,
  messageContent,
  messageFields,
  messageLink,
  needsPlatformMarkup,
  outboundBody,
  outboundMessage,
  plainTextOf,
  platformNote,
  renderMessageContent,
  takeLines,
  untrustedText,
  withOutboundBody,
} from './message-rendering';

const CTX = { platform: 'test', channelId: 'c', userId: 'u' };

/** A markup that makes every platform-rendered span visibly longer than its plain form, to show budgets use it. */
const WIDE: MessageMarkup = {
  untrusted: (text, guard) => `{${guard}:${text}}`,
  link: (url) => `<${url}>`,
  conversation: (ref) => `[${ref.platform}:${ref.direct ? 'direct' : ref.id ?? ref.label}]`,
  platformNote: (topic) => ` (note ${topic})`,
};

describe('platform-neutral message content (PLT-0)', () => {
  it('renders spans with the given markup and plainly for OutboundMessage.text', () => {
    const body = messageContent('a ', untrustedText('*x*'), ' ', messageLink('https://e.test'), ' ', conversationRefOf({ platform: 'test', spaceId: 's', channelId: '9', userId: 'u' }, { direct: 'DM', channel: '채널' }), platformNote('command-prefix'));
    expect(renderMessageContent(body, WIDE)).toBe('a {markup:*x*} <https://e.test> [test:9] (note command-prefix)');
    expect(plainTextOf(body)).toBe('a *x* https://e.test #9');
    expect(renderMessageContent(body, PLAIN_TEXT_MARKUP)).toBe(plainTextOf(body));
    expect(renderMessageContent('plain', WIDE)).toBe('plain');
    expect(renderMessageContent(messageContent(untrustedText('m', 'mentions'), untrustedText('h', 'handles')), WIDE)).toBe('{mentions:m}{handles:h}');
  });

  it('builds conversation references from the context: direct by the adapter flag, else by the absence of a space', () => {
    const labels = { direct: 'DM', channel: '채널' };
    expect(conversationRefOf({ platform: 'p', spaceId: 's', channelId: 'c', threadId: 't', userId: 'u' }, labels)).toEqual({
      kind: 'conversation', platform: 'p', direct: false, id: 't', label: '채널',
    });
    expect(conversationRefOf({ platform: 'p', channelId: 'c', userId: 'u', direct: true }, labels)).toEqual({ kind: 'conversation', platform: 'p', direct: true, label: 'DM' });
    // A group without a space (e.g. a future platform) is not direct when the adapter says so.
    expect(isDirectConversation({ platform: 'p', channelId: 'c', userId: 'u', direct: false })).toBe(false);
    // An older context (no flag) without a space is direct; an unsafe id is never referenced.
    expect(isDirectConversation({ platform: 'p', channelId: 'c', userId: 'u' })).toBe(true);
    expect(conversationRefOf({ platform: 'p', spaceId: 's', channelId: 'a b', userId: 'u' }, labels)).toEqual({ kind: 'conversation', platform: 'p', direct: false, label: '채널' });
    expect(plainTextOf(messageContent(conversationRefOf({ platform: 'p', spaceId: 's', channelId: 'c', userId: 'u' }, labels)))).toBe('#c');
    expect(plainTextOf(messageContent(conversationRefOf({ platform: 'p', channelId: 'c', userId: 'u' }, labels)))).toBe('DM');
  });

  it('merges adjacent strings, flattens bodies and refuses to be stringified', () => {
    const content = messageContent('a', '', 'b', messageContent('c', untrustedText('d')), 'e');
    expect([...content]).toEqual(['abc', { kind: 'untrusted', text: 'd', guard: 'markup' }, 'e']);
    expect(Object.isFrozen(content)).toBe(true);
    expect(() => `${content}`).toThrow(TypeError);
    expect(() => String(joinMessage(['x', 'y']))).toThrow(TypeError);
    // Every node too (review P3-2): a node interpolated by mistake throws instead of writing "[object Object]".
    for (const node of [untrustedText('x'), messageLink('u'), platformNote('command-prefix'), clipMessage('a', 1, 'utf16'), fitLines([], 1), takeLines({ unit: 'utf16', maxChars: 1, baseChars: 0, head: [], tail: [], lines: [] }), conversationRefOf({ platform: 'p', channelId: 'c', userId: 'u' }, { direct: 'd', channel: 'c' })]) {
      expect(() => `${node}`).toThrow(TypeError);
      expect(Object.keys(node)).not.toContain('toString');
    }
    expect(plainTextOf(joinMessage(['x', untrustedText('y'), 'z'], ' | '))).toBe('x | y | z');
  });

  it('a body of Quoky copy alone (budgets included) is just its plain text; untrusted content stays content', () => {
    expect(messageBody('a', 'b')).toBe('ab');
    expect(joinBody(['a', 'b'])).toBe('a\nb');
    expect(messageBody(clipMessage('abcdef', 4, 'utf16'))).toBe('abc…');
    expect(messageBody(fitLines([{ content: 'x' }], 10))).toBe('x');
    const content = messageBody('a', untrustedText('b'));
    expect(typeof content).not.toBe('string');
    expect(needsPlatformMarkup(content)).toBe(true);
    expect(needsPlatformMarkup(messageContent(clipMessage(messageContent(messageLink('u')), 9, 'utf16')))).toBe(true);
    expect(needsPlatformMarkup(messageContent(takeLines({ unit: 'utf16', maxChars: 9, baseChars: 0, head: [], tail: [], lines: [{ content: 'x' }] })))).toBe(false);
  });

  it('builds outbound messages: content only when a span is platform-rendered, never a stale one', () => {
    expect(outboundMessage(CTX, 'hi')).toEqual({ context: CTX, text: 'hi' });
    const rich = outboundMessage(CTX, messageContent('see ', messageLink('https://e.test')), { replyToMessageId: 'm' });
    expect(rich).toEqual({ context: CTX, text: 'see https://e.test', content: ['see ', { kind: 'link', url: 'https://e.test' }], replyToMessageId: 'm' });
    expect(outboundBody(rich)).toBe(rich.content);
    expect(outboundBody({ text: 't' })).toBe('t');
    const replaced = withOutboundBody({ ...rich, format: 'model-reply' }, 'plain now');
    expect(replaced).toEqual({ context: CTX, text: 'plain now', replyToMessageId: 'm', format: 'model-reply' });
    expect('content' in replaced).toBe(false);
    expect(messageFields(messageContent(untrustedText('x')))).toEqual({ text: 'x', content: [{ kind: 'untrusted', text: 'x', guard: 'markup' }] });
  });

  describe('clip', () => {
    it('clips the rendered text (UTF-16 or code points) and keeps `after` whole, reserving its length', () => {
      const node = messageContent(clipMessage(messageContent(untrustedText('abcdef')), 10, 'utf16'));
      expect(renderMessageContent(node, PLAIN_TEXT_MARKUP)).toBe('abcdef');
      expect(renderMessageContent(node, WIDE)).toBe('{markup:a…');
      const emoji = messageContent(clipMessage('😀😀😀😀', 3, 'code-points'));
      expect(plainTextOf(emoji)).toBe('😀😀…');
      expect(plainTextOf(messageContent(clipMessage('😀😀😀😀', 3, 'utf16')))).toBe('😀…');
      const withAfter = messageContent(clipMessage('0123456789', 8, 'code-points', { after: messageContent('|', untrustedText('ab')) }));
      expect(plainTextOf(withAfter)).toBe('0123…|ab');
      // Wide, `after` alone (12) exceeds the budget: nothing of the content is kept.
      expect(renderMessageContent(withAfter, WIDE)).toBe('|{markup:ab}');
      expect(plainTextOf(messageContent(clipMessage('  pad  ', 3, 'utf16', { trim: true })))).toBe('pad');
    });
  });

  describe('fit-lines', () => {
    const lines = [
      { content: 'head' },
      { content: messageContent('a ', untrustedText('1')), droppable: true },
      { content: messageContent('b ', untrustedText('2')), droppable: true },
      { content: 'tail' },
    ];

    it('drops droppable lines from the end, measured on the rendered text, then notes it', () => {
      const node = messageContent(fitLines(lines, 22, '(cut)'));
      expect(plainTextOf(node)).toBe('head\na 1\nb 2\ntail');
      // Rendered wide, "a {markup:1}" is 12 characters: both droppable lines go.
      expect(renderMessageContent(node, WIDE)).toBe('head\ntail\n(cut)');
    });

    it('without a note it only drops; a text that still does not fit is clipped', () => {
      // Without the note, dropping "b" is enough (22 characters).
      expect(renderMessageContent(messageContent(fitLines(lines, 22)), WIDE)).toBe('head\na {markup:1}\ntail');
      expect(plainTextOf(messageContent(fitLines([{ content: 'x'.repeat(30) }], 10)))).toBe(`${'x'.repeat(9)}…`);
    });
  });

  describe('take-lines', () => {
    const lines = [
      { content: 'Day 1' },
      { content: messageContent('- ', untrustedText('one')), item: true },
      { content: 'Day 2' },
      { content: messageContent('- ', untrustedText('two')), item: true },
      { content: messageContent('- ', untrustedText('three')), item: true },
    ];
    const node = (maxChars: number, extra: Partial<Parameters<typeof takeLines>[0]> = {}) =>
      messageContent(
        takeLines({
          unit: 'code-points',
          maxChars,
          baseChars: 2,
          head: ['H'],
          tail: ['T'],
          lines,
          dropTrailingHeadings: true,
          omitted: { hidden: 0, before: '…+', after: '' },
          ...extra,
        }),
      );

    it('takes the leading lines that fit in the rendered text, counts left-out items and drops a dangling heading', () => {
      expect(plainTextOf(node(100))).toBe('H\nDay 1\n- one\nDay 2\n- two\n- three\nT');
      // Base 2 + H + T = 4; plain: "Day 1"(6) "- one"(6) "Day 2"(6) -> 22; "- two"(6) would make 28 > 25.
      expect(plainTextOf(node(25))).toBe('H\nDay 1\n- one\n…+2\nT');
      // Wide: "- {markup:one}" is 15 characters.
      expect(renderMessageContent(node(25), WIDE)).toBe('H\nDay 1\n- {markup:one}\n…+2\nT');
      expect(renderMessageContent(node(20), WIDE)).toBe('H\n…+3\nT');
    });

    it('counts hidden items, and can emit the head only with lines', () => {
      expect(plainTextOf(node(100, { omitted: { hidden: 4, before: '…and ', after: ' more' } }))).toBe('H\nDay 1\n- one\nDay 2\n- two\n- three\n…and 4 more\nT');
      const links = (maxChars: number) =>
        messageContent(
          takeLines({ unit: 'utf16', maxChars, baseChars: 5, head: ['출처:'], tail: ['used 2'], headOnlyWithLines: true, lines: [{ content: messageContent('- ', messageLink('https://a.test')) }] }),
        );
      expect(plainTextOf(links(100))).toBe('출처:\n- https://a.test\nused 2');
      expect(plainTextOf(links(20))).toBe('used 2');
    });
  });
});

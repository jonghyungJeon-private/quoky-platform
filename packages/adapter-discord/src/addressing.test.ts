import { describe, expect, it } from 'vitest';
import { hasEffectiveText } from '@quoky/core';
import { isAddressingOnly, normalizeInboundText } from './addressing';

/** The mention-only and invisible-only texts Core's `hasEffectiveText` used to recognize itself before TG-1. */
const ADDRESSING_ONLY = ['<@123456789012345678>', '<@!123456789012345678>', '<@&42> <#99>', '<@1>​ ', '<#C1|general>'];

describe('Discord inbound addressing (TG-1: moved out of Core)', () => {
  it('an addressing-only attachment message reaches Core as the empty text, so Core sees no effective text as before', () => {
    for (const text of ADDRESSING_ONLY) {
      expect(isAddressingOnly(text), text).toBe(true);
      const normalized = normalizeInboundText(text, true);
      expect(normalized).toBe('');
      expect(hasEffectiveText(normalized)).toBe(false);
    }
  });

  it('every other text is unchanged: a message without attachments, real content next to a mention, invisible-only', () => {
    for (const text of ADDRESSING_ONLY) expect(normalizeInboundText(text, false)).toBe(text);
    for (const text of ['<@1> 요약해줘', 'hello', '​', '', '<b>', '@everyone']) {
      expect(normalizeInboundText(text, true), text).toBe(text);
    }
    expect(hasEffectiveText('<@1> 요약해줘')).toBe(true);
  });
});

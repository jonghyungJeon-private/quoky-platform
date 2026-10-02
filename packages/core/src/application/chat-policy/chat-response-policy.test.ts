import { describe, expect, it } from 'vitest';
import {
  CHAT_CAPABILITY_HONESTY_RULE,
  CHAT_FORMATTING_RULE,
  CHAT_INJECTION_RULE,
  CHAT_NO_UNREQUESTED_TRANSLATION_RULE,
  GENERAL_CHAT_POLICY_RULES,
  detectReplyLanguage,
  hasExplicitLanguageRequest,
  renderGeneralChatPolicyRules,
  replyLanguageFact,
} from './chat-response-policy';

describe('detectReplyLanguage', () => {
  it.each([
    ['안녕하세요, 오늘 날씨 어때요?', 'ko'],
    ['Hello, how does the approval flow work?', 'en'],
    ['pnpm test 실행해줘', 'ko'],
    ['이 함수는 뭐야 what', 'ko'],
  ] as const)('classifies %j as %s', (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });

  it('is unknown for empty, emoji-only and punctuation-only input', () => {
    expect(detectReplyLanguage('')).toBe('unknown');
    expect(detectReplyLanguage('👍🎉')).toBe('unknown');
    expect(detectReplyLanguage('?!... 123')).toBe('unknown');
  });

  it('ignores fenced code, inline code, URLs and path tokens', () => {
    expect(detectReplyLanguage('```ts\nconst answer = compute(value);\n```')).toBe('unknown');
    expect(detectReplyLanguage('`pnpm install`')).toBe('unknown');
    expect(detectReplyLanguage('https://example.com/docs/getting-started')).toBe('unknown');
    expect(detectReplyLanguage('packages/core/src/index.ts')).toBe('unknown');
    expect(detectReplyLanguage('~/work/notes.md')).toBe('unknown');
    expect(
      detectReplyLanguage('이 파일 설명해줘 packages/core/src/application/prompt-composer.ts'),
    ).toBe('ko');
    expect(
      detectReplyLanguage('Explain this please ```const 인사 = 1;``` and https://example.com/한글'),
    ).toBe('en');
  });

  it('is unknown for other scripts and ambiguous Latin plus other-script mixes', () => {
    expect(detectReplyLanguage('こんにちは、元気ですか')).toBe('unknown');
    expect(detectReplyLanguage('Hello こんにちは こんにちは こんにちは')).toBe('unknown');
  });

  it('applies the 30% Hangul and 80% Latin thresholds', () => {
    // 3 Hangul + 7 Latin letters = exactly 30% Hangul.
    expect(detectReplyLanguage('가나다 abcdefg')).toBe('ko');
    // 2 Hangul + 8 Latin = 20% Hangul: neither Korean nor English.
    expect(detectReplyLanguage('가나 abcdefgh')).toBe('unknown');
  });
});

describe('hasExplicitLanguageRequest', () => {
  it.each([
    '영어로 알려줘',
    '영문으로 써줘',
    '한국어로 답해줘',
    '일본어로 말해줘',
    '이 문장 번역해줘',
    'please translate this',
    'Answer in English',
    'reply in Korean please',
  ])('detects %j', (text) => {
    expect(hasExplicitLanguageRequest(text)).toBe(true);
  });

  it.each(['안녕하세요', 'What is the status?', 'English muffins are tasty'])(
    'does not flag %j',
    (text) => {
      expect(hasExplicitLanguageRequest(text)).toBe(false);
    },
  );
});

describe('replyLanguageFact', () => {
  it('names Korean for a Korean message and English for an English message', () => {
    expect(replyLanguageFact('안녕?')).toBe(
      'Reply language for this turn: Korean (ko), determined by Core from the current User message.',
    );
    expect(replyLanguageFact('How are you?')).toBe(
      'Reply language for this turn: English (en), determined by Core from the current User message.',
    );
  });

  it('falls back to the generic same-language rule for unknown or explicit requests', () => {
    const generic =
      'Reply language for this turn: the language of the current User message, unless that message explicitly requests another language.';
    expect(replyLanguageFact('👍')).toBe(generic);
    expect(replyLanguageFact('이 문장을 영어로 번역해줘')).toBe(generic);
    expect(replyLanguageFact('Translate this to Korean')).toBe(generic);
  });
});

describe('GENERAL_CHAT policy rules', () => {
  it('exposes the four fixed rules in order and renders them as one paragraph', () => {
    expect(GENERAL_CHAT_POLICY_RULES).toEqual([
      CHAT_NO_UNREQUESTED_TRANSLATION_RULE,
      CHAT_CAPABILITY_HONESTY_RULE,
      CHAT_INJECTION_RULE,
      CHAT_FORMATTING_RULE,
    ]);
    expect(Object.isFrozen(GENERAL_CHAT_POLICY_RULES)).toBe(true);
    expect(renderGeneralChatPolicyRules()).toBe(GENERAL_CHAT_POLICY_RULES.join(' '));
    expect(renderGeneralChatPolicyRules()).not.toContain('\n');
  });

  it('states the required behaviours', () => {
    expect(CHAT_NO_UNREQUESTED_TRANSLATION_RULE).toContain('translation');
    expect(CHAT_CAPABILITY_HONESTY_RULE).toContain('performs no action');
    expect(CHAT_CAPABILITY_HONESTY_RULE).toContain('"도움말"');
    expect(CHAT_INJECTION_RULE).toContain('one short sentence');
    expect(CHAT_INJECTION_RULE).toContain('never announce compliance');
    expect(CHAT_FORMATTING_RULE).toContain('approval prompts');
  });

  it('stays small enough for the Ollama 4096-token context', () => {
    expect(renderGeneralChatPolicyRules().length).toBeLessThan(900);
  });

  it('contains no provider identifiers', () => {
    expect(renderGeneralChatPolicyRules()).not.toMatch(/ollama|claude|codex|llama/i);
  });
});

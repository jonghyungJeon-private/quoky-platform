import { describe, expect, it } from 'vitest';
import { generalChatReplyPolicy } from '@quoky/core';
import {
  normalizeLiteralEscapes,
  sanitizeGeneralChatText,
  sanitizeTerminalOutput,
  stripInternalMetadataEnvelope,
  stripUnsolicitedTranslationBlock,
} from './output-sanitizer';

describe('sanitizeTerminalOutput', () => {
  it('removes the observed ESC[K sequence and other CSI sequences', () => {
    expect(sanitizeTerminalOutput('before\x1B[Kafter')).toBe('beforeafter');
    expect(sanitizeTerminalOutput('\x1B[31mred\x1B[0m')).toBe('red');
  });

  it('removes OSC sequences terminated by BEL or ST', () => {
    expect(sanitizeTerminalOutput('a\x1B]0;title\x07b')).toBe('ab');
    expect(sanitizeTerminalOutput('a\x1B]8;;https://example.com\x1B\\link\x1B]8;;\x1B\\b')).toBe('alinkb');
  });

  it('removes disallowed C0 controls while preserving newline, carriage return, and tab', () => {
    expect(sanitizeTerminalOutput('a\x00b\x01c\n\r\td')).toBe('abc\n\r\td');
  });

  it('preserves Korean, Unicode, Markdown, and code fences', () => {
    const text = '## 상태 ✅\n\n```ts\nconst 인사 = \"안녕\";\n```\n';
    expect(sanitizeTerminalOutput(text)).toBe(text);
  });

  it('does not remove natural-language parenthetical text', () => {
    const text = "(I'll respond as Quoky, a concise assistant)";
    expect(sanitizeTerminalOutput(text)).toBe(text);
  });

  it('does not rewrite role/provenance content while sanitizing terminal framing', () => {
    const envelope = JSON.stringify({
      role: 'assistant',
      provenance: 'ASSISTANT',
      epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE',
      content: '안녕?',
    });
    expect(sanitizeTerminalOutput(envelope)).toBe(envelope);
  });
});

describe('stripInternalMetadataEnvelope', () => {
  it('unwraps an internal JSON role/provenance/epistemic envelope', () => {
    const envelope = JSON.stringify({
      role: 'assistant',
      provenance: 'ASSISTANT',
      epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE',
      content: '안녕?',
    });
    expect(stripInternalMetadataEnvelope(envelope)).toBe('안녕?');
  });

  it('strips internal metadata lines while preserving Korean response content', () => {
    const output = [
      'Provenance: ASSISTANT',
      'Epistemic status: ASSISTANT_NON_AUTHORITATIVE',
      '',
      '바로 전에 “안녕?”이라고 말했어요.',
    ].join('\n');
    expect(stripInternalMetadataEnvelope(output)).toBe('바로 전에 “안녕?”이라고 말했어요.');
  });

  it('unwraps the adapter-rendered Assistant message envelope', () => {
    const output = [
      '## ASSISTANT message',
      'Provenance: ASSISTANT',
      'Epistemic status: ASSISTANT_NON_AUTHORITATIVE',
      'Content: "메타데이터 없는 응답"',
    ].join('\n');
    expect(stripInternalMetadataEnvelope(output)).toBe('메타데이터 없는 응답');
  });

  it('handles leading whitespace and the serialized conversation header', () => {
    const output = [
      '',
      '  # Role-attributed conversation',
      '',
      '  ## ASSISTANT message',
      '  Provenance: ASSISTANT',
      '  Epistemic status: ASSISTANT_NON_AUTHORITATIVE',
      '  Content: "앞부분이 정리된 응답"',
    ].join('\n');

    expect(stripInternalMetadataEnvelope(output)).toBe('앞부분이 정리된 응답');
  });

  it('unwraps every metadata block and preserves trailing response prose', () => {
    const output = [
      '## ASSISTANT message',
      'Provenance: ASSISTANT',
      'Epistemic status: ASSISTANT_NON_AUTHORITATIVE',
      'Content: "첫 문장"',
      '',
      '## ASSISTANT message',
      'Provenance: ASSISTANT',
      'Epistemic status: ASSISTANT_NON_AUTHORITATIVE',
      'Content: "둘째 문장"',
      '추가문장',
    ].join('\n');

    expect(stripInternalMetadataEnvelope(output)).toBe('첫 문장\n\n둘째 문장\n추가문장');
  });

  it('rejects an echoed serialized USER transcript block instead of replaying its content', () => {
    const output = [
      '## USER message',
      'Provenance: USER',
      'Epistemic status: USER_CLAIM_OR_INTENT',
      'Content: "사용자 응답 내용"',
    ].join('\n');

    expect(stripInternalMetadataEnvelope(output)).toBe('');
  });

  it('selects only Assistant content when stdout echoes USER history before an answer', () => {
    const output = [
      '# Role-attributed conversation',
      '## USER message',
      'Provenance: USER',
      'Epistemic status: USER_CLAIM_OR_INTENT',
      'Content: "내가 방금 뭐라했어 ?"',
      '',
      '## ASSISTANT message',
      'Provenance: ASSISTANT',
      'Epistemic status: ASSISTANT_NON_AUTHORITATIVE',
      'Content: "새 질문에 대한 응답"',
    ].join('\n');

    expect(stripInternalMetadataEnvelope(output)).toBe('새 질문에 대한 응답');
  });

  it('preserves similar natural-language or incomplete metadata text', () => {
    const text = 'Provenance: ASSISTANT라고 쓰인 문장은 metadata envelope가 아닙니다.';
    expect(stripInternalMetadataEnvelope(text)).toBe(text);
  });
});

describe('stripUnsolicitedTranslationBlock', () => {
  const korean = '오늘은 날씨가 맑고 따뜻해요.';
  const english = 'It is sunny and warm today.';

  it('removes a trailing "(Translated from Korean)" block after a Korean body', () => {
    const text = `${korean}\n\n(Translated from Korean)\n${english}`;
    expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('오늘 날씨 어때?'))).toBe(korean);
  });

  it.each(['Translation:', 'English translation:', '[Translation]', '번역:', 'In English:'])(
    'removes a block headed by %s',
    (heading) => {
      const text = `${korean}\n\n${heading}\n${english}`;
      expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('오늘 날씨 어때?'))).toBe(korean);
    },
  );

  it('removes an unsolicited Korean block after an English body for an English question', () => {
    const text = `${english}\n\n(Translated from English)\n${korean}`;
    expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('How is the weather?'))).toBe(english);
  });

  it('keeps the block when the User asked for a translation or language', () => {
    const text = `${korean}\n\n(Translated from Korean)\n${english}`;
    expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('영어로 번역해줘'))).toBe(text);
    expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('Please translate this'))).toBe(text);
    expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('날씨를 in English 로'))).toBe(text);
  });

  it('keeps everything when the current message is missing or has an unknown language', () => {
    const text = `${korean}\n\n(Translated from Korean)\n${english}`;
    expect(stripUnsolicitedTranslationBlock(text, undefined)).toBe(text);
    expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('👍'))).toBe(text);
    expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('```ts\nconst a = 1;\n```'))).toBe(text);
  });

  it('keeps text when the body is not in the User language or the block is in the same script', () => {
    const englishBody = `${english}\n\n(Translated from English)\n${korean}`;
    expect(stripUnsolicitedTranslationBlock(englishBody, generalChatReplyPolicy('오늘 날씨 어때?'))).toBe(englishBody);
    const sameScript = `${korean}\n\n번역:\n${korean} 더 자세히 말하면 맑아요.`;
    expect(stripUnsolicitedTranslationBlock(sameScript, generalChatReplyPolicy('오늘 날씨 어때?'))).toBe(sameScript);
  });

  it('keeps text with no explicit marker line, a marker with no body, or an inline mention', () => {
    expect(stripUnsolicitedTranslationBlock(`${korean}\n${english}`, generalChatReplyPolicy('안녕'))).toBe(
      `${korean}\n${english}`,
    );
    const noBody = `(Translated from Korean)\n${english}`;
    expect(stripUnsolicitedTranslationBlock(noBody, generalChatReplyPolicy('안녕'))).toBe(noBody);
    const inline = `${korean}\nTranslation memory is a CAT tool feature.`;
    expect(stripUnsolicitedTranslationBlock(inline, generalChatReplyPolicy('안녕'))).toBe(inline);
    const sentence = `${korean}\nIn English, that means sunny.`;
    expect(stripUnsolicitedTranslationBlock(sentence, generalChatReplyPolicy('안녕'))).toBe(sentence);
  });

  it('handles CRLF line endings', () => {
    const text = `${korean}\r\n\r\n(Translated from Korean)\r\n${english}`;
    expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('안녕'))).toBe(korean);
  });

  describe('code is never inspected or stripped', () => {
    it('ignores a translation marker on an indented-code line (Codex delta repro)', () => {
      const text = '설명입니다.\n\n    In English:\nNever delete the backup.';
      expect(sanitizeGeneralChatText(text, generalChatReplyPolicy('백업 설명해줘'))).toBe(text);
      const tab = '설명입니다.\n\n\tIn English:\nNever delete the backup.';
      expect(sanitizeGeneralChatText(tab, generalChatReplyPolicy('백업 설명해줘'))).toBe(tab);
      const mixed = '설명입니다.\n\n \tIn English:\nNever delete the backup.';
      expect(sanitizeGeneralChatText(mixed, generalChatReplyPolicy('백업 설명해줘'))).toBe(mixed);
    });
    it('keeps a fenced example that contains a translation marker (review repro)', () => {
      const text = [
        '백업 정책은 이렇게 적으면 됩니다.',
        '',
        '```text',
        'In English:',
        'Never delete the backup.',
        '```',
      ].join('\n');
      expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('백업 정책 예시 보여줘'))).toBe(text);
    });

    it('keeps a tilde-fenced example that contains a translation marker', () => {
      const text = ['설명입니다.', '', '~~~', 'Translation:', 'Never delete the backup.', '~~~'].join('\n');
      expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('안녕'))).toBe(text);
    });

    it('treats a shorter fence inside a longer one as content (nested fences)', () => {
      const text = [
        '마크다운 예시입니다.',
        '',
        '````markdown',
        '```text',
        '```',
        'In English:',
        'Never delete the backup.',
        '````',
      ].join('\n');
      expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('안녕'))).toBe(text);
      const tildeInBacktick = ['예시입니다.', '```', '~~~', '번역:', 'Never delete it.', '```'].join('\n');
      expect(stripUnsolicitedTranslationBlock(tildeInBacktick, generalChatReplyPolicy('안녕'))).toBe(tildeInBacktick);
    });

    it('does not strip anything when a fence is left open', () => {
      const text = [korean, '', '```', 'code', '', '(Translated from Korean)', english].join('\n');
      expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('안녕'))).toBe(text);
      const openAfterMarker = [korean, '', 'Translation:', english, '```', 'code'].join('\n');
      expect(stripUnsolicitedTranslationBlock(openAfterMarker, generalChatReplyPolicy('안녕'))).toBe(openAfterMarker);
    });

    it('does not strip a marked section that contains or is followed by code', () => {
      const fenced = [korean, '', 'In English:', english, '```', 'rm -rf build', '```'].join('\n');
      expect(stripUnsolicitedTranslationBlock(fenced, generalChatReplyPolicy('안녕'))).toBe(fenced);
      const indented = [korean, '', 'In English:', english, '', '    rm -rf build'].join('\n');
      expect(stripUnsolicitedTranslationBlock(indented, generalChatReplyPolicy('안녕'))).toBe(indented);
    });

    it('ignores a marker inside an inline code span or an indented code line', () => {
      const inlineSpan = [`${korean} \`x`, 'Translation: y`', english].join('\n');
      expect(stripUnsolicitedTranslationBlock(inlineSpan, generalChatReplyPolicy('안녕'))).toBe(inlineSpan);
      const indentedMarker = [korean, '', '    In English:', `    ${english}`].join('\n');
      expect(stripUnsolicitedTranslationBlock(indentedMarker, generalChatReplyPolicy('안녕'))).toBe(indentedMarker);
    });

    it('still strips a trailing prose translation after a balanced code block', () => {
      const body = [korean, '', '```ts', 'const a = "In English:";', '```'].join('\n');
      const text = `${body}\n\n(Translated from Korean)\n${english}`;
      expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('오늘 날씨 어때?'))).toBe(body);
    });

    it('keeps literal \\n inside code intact while stripping the trailing translation', () => {
      const body = [korean, '', '```js', 'console.log("a\\nb\\nc");', '```', '', '`\\n`은 줄바꿈이에요.'].join('\n');
      const text = `${body}\n\nIn English:\n${english}`;
      expect(stripUnsolicitedTranslationBlock(text, generalChatReplyPolicy('줄바꿈 알려줘'))).toBe(body);
      expect(sanitizeGeneralChatText(text, generalChatReplyPolicy('줄바꿈 알려줘'))).toBe(body);
      expect(sanitizeGeneralChatText(body, generalChatReplyPolicy('줄바꿈 알려줘'))).toBe(body);
    });
  });
});

describe('normalizeLiteralEscapes', () => {
  it('converts literal \\n outside code when there is no real newline and at least two occurrences', () => {
    expect(normalizeLiteralEscapes('첫 줄\\n\\n둘째 줄')).toBe('첫 줄\n\n둘째 줄');
    expect(normalizeLiteralEscapes('a\\nb\\nc')).toBe('a\nb\nc');
  });

  it('leaves a single literal \\n untouched', () => {
    expect(normalizeLiteralEscapes('use \\n to break a line')).toBe('use \\n to break a line');
  });

  it('leaves text that already has a real newline untouched', () => {
    expect(normalizeLiteralEscapes('a\\nb\\nc\nd')).toBe('a\\nb\\nc\nd');
  });

  it('never rewrites code fences or inline code', () => {
    const fenced = '```\nconsole.log("a\\nb\\nc");\n```';
    expect(normalizeLiteralEscapes(fenced)).toBe(fenced);
    const singleLineFence = '```console.log("a\\nb\\nc")```';
    expect(normalizeLiteralEscapes(singleLineFence)).toBe(singleLineFence);
    expect(normalizeLiteralEscapes('use `\\n` and `\\n` in code')).toBe('use `\\n` and `\\n` in code');
    const tildeFence = '~~~console.log("a\\nb\\nc")~~~';
    expect(normalizeLiteralEscapes(tildeFence)).toBe(tildeFence);
  });

  it('converts only the prose around inline code and counts only prose occurrences', () => {
    expect(normalizeLiteralEscapes('x\\ny\\n`keep\\n`')).toBe('x\ny\n`keep\\n`');
    expect(normalizeLiteralEscapes('x\\n `a\\n` `b\\n`')).toBe('x\\n `a\\n` `b\\n`');
  });

  it('does not touch an escaped backslash followed by n', () => {
    expect(normalizeLiteralEscapes('a\\\\nb\\\\nc')).toBe('a\\\\nb\\\\nc');
  });
});

describe('sanitizeGeneralChatText', () => {
  it('normalizes literal newlines first so a marker on an escaped line is still recognized', () => {
    const output = '오늘은 맑아요.\\n\\n(Translated from Korean)\\nIt is sunny today.';
    expect(sanitizeGeneralChatText(output, generalChatReplyPolicy('오늘 날씨 어때?'))).toBe('오늘은 맑아요.');
  });

  it('only normalizes escapes when the current message is not supplied', () => {
    expect(sanitizeGeneralChatText('가\\n\\n나')).toBe('가\n\n나');
    const text = '오늘은 맑아요.\n\n(Translated from Korean)\nIt is sunny today.';
    expect(sanitizeGeneralChatText(text)).toBe(text);
  });

  it('leaves ordinary answers unchanged', () => {
    expect(sanitizeGeneralChatText('안녕하세요!', generalChatReplyPolicy('안녕'))).toBe('안녕하세요!');
  });
});

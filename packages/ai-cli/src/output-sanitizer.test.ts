import { describe, expect, it } from 'vitest';
import { generalChatReplyPolicy } from '@quoky/core';
import {
  UNSUPPORTED_ACTION_NOTICE_EN,
  UNSUPPORTED_ACTION_NOTICE_KO,
  claimsUnsupportedExternalAction,
  guardUnsupportedActionClaims,
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

describe('action-claim guard (ADR-0098 amendment D2)', () => {
  const ko = generalChatReplyPolicy('내일 회의 캘린더에 추가해줘');
  const en = generalChatReplyPolicy('Add the meeting to my calendar');
  const ja = generalChatReplyPolicy('明日の会議をカレンダーに追加して');

  it.each([
    '네! 구글 캘린더에 내일 오후 3시 회의를 추가해 드릴게요.',
    '구글 캘린더에 일정을 등록했어요.',
    '캘린더에 넣어 드렸어요!',
    '회의 일정을 잡아 드렸어요.',
    '내일 오전 회의를 일정에 추가해 드렸습니다.',
    '김부장님께 메일을 보내드릴게요.',
    '이메일 발송을 완료했습니다.',
    '메일로 보냈어요.',
    '동생에게 문자를 보냈습니다.',
    '엄마에게 전화 걸어 드릴게요.',
    '강남역 식당 예약했어요.',
    '예약이 완료되었습니다.',
    'KTX 예매해 드렸어요.',
    '결제를 진행했어요. 결제가 완료되었습니다.',
    '송금했습니다!',
    '엄마 계좌로 10만원을 보내드렸어요.',
    '트위터에 올렸어요.',
    '슬랙 채널에 공지를 게시했습니다.',
    'Sure! I have added the meeting to your calendar.',
    "I've added it to your Google Calendar.",
    "I'll send the email to your manager right away.",
    'I will send him a text now.',
    'Let me book a table for two at 7pm.',
    "I'm scheduling the meeting for tomorrow.",
    'I sent the email.',
    "I've emailed John the report.",
    'I paid the electricity bill.',
    'I posted it on LinkedIn.',
    'Done! Your meeting has been added to your calendar.',
    'Your reservation has been confirmed.',
    "I've added the meeting with Bob and Alice from marketing to your calendar.",
    "I'll put it on your Outlook calendar.",
    'I booked a table for two at 7pm.',
    "I've reserved two seats for the 8pm show.",
    "I'll call your mom now.",
    'I called him.',
    "I've placed your order.",
    'I placed an order for two pizzas.',
    'I ordered pizza for you.',
    'I bought the tickets.',
    "I've transferred the money to your landlord.",
    "I'll share it on your Slack channel.",
    'The email has been sent to your manager.',
    '캘린더에 추가해 드릴게요: 내일 오후 3시 회의',
    '네, 결제가 완료되었어요.',
  ])('flags a claimed external action: %s', (reply) => {
    expect(claimsUnsupportedExternalAction(reply)).toBe(true);
  });

  it.each([
    '저는 캘린더에 일정을 추가할 수 없어요. 직접 추가해 주세요.',
    '메일을 보내는 방법은 다음과 같아요.',
    '메일 초안을 써 드릴게요:\n\n안녕하세요, 김부장님.',
    '예약했는지 앱에서 확인해 보세요.',
    '메일을 보냈다면 답장을 기다려 보세요.',
    '결제가 완료되었는지 카드사 앱에서 확인할 수 있어요.',
    '여행 일정에 박물관 방문을 추가했어요.',
    '회의록을 정리했어요.',
    '예시 코드에 함수를 추가했어요.',
    '결제 완료 화면을 만들려면 상태 값을 하나 두면 돼요.',
    '아무것도 보내지 않았어요.',
    "I can't add events to your calendar, but here is a draft invite.",
    "I haven't sent anything.",
    'I will not send the email.',
    'If I sent the email, you would get a copy.',
    'Here is a draft email you can send to your manager.',
    'To send an email, open Gmail and click Compose.',
    "I've added a comment to the code below.",
    'I paid close attention to the wording.',
    '```\nawait calendar.events.insert(event); // 캘린더에 추가했어요\n```',
    'Use `sendMail()`; it reports "메일을 보냈어요" when it succeeds.',
    '> 구글 캘린더에 추가해 드릴게요.\n\n이런 문장은 실제로 실행된 작업이 없을 때 쓰면 안 돼요.',
    // Review round 1: ordinary coding/planning phrasings are not external-action claims.
    "I've added a calendar component to the example below.",
    "I'll add a calendar view to your React app like this:",
    "I've added your calendar view component below.",
    'I placed the items in order.',
    'Let me place the order of operations in a list.',
    "I'll call back to the earlier point.",
    "I'll call this function with them.",
    'I bought into that idea once.',
    "I'll share a channel-based design with you.",
    "I'll share a blog post template below.",
    "I've reserved space in the buffer for the header.",
    "I've scheduled the cron job to run nightly; see the jobs table.",
    "I'll send a message to the queue when the job finishes.",
    'I transferred ownership of the account to the new module.',
    'Your order has been placed - this is the success message the API returns.',
    'The message has been sent to the worker.',
    '사용자가 버튼을 누르면 예약이 완료됐어요 메시지를 보여줍니다.',
    '결제가 완료되었어요 화면을 띄우세요.',
    '"결제가 완료되었어요"라는 문구 대신 "결제 완료"를 쓰세요.',
    '주문이 완료됐어요라는 토스트를 띄우면 돼요.',
    '아래와 같이 일정을 추가해 드릴게요: 1) 기상 2) 운동',
    '오늘 일정을 추가해 드릴게요:\n- 07:00 기상\n- 08:00 운동',
  ])('keeps a reply that claims no action: %s', (reply) => {
    expect(claimsUnsupportedExternalAction(reply)).toBe(false);
  });

  it('replaces the whole reply with the notice in the reply language', () => {
    const reply = '네! 구글 캘린더에 내일 오후 3시 회의를 추가해 드릴게요. 다른 일정도 있으면 말씀해 주세요.';
    expect(guardUnsupportedActionClaims(reply, ko)).toBe(UNSUPPORTED_ACTION_NOTICE_KO);
    expect(guardUnsupportedActionClaims("I've added the meeting to your calendar.", en)).toBe(UNSUPPORTED_ACTION_NOTICE_EN);
    expect(UNSUPPORTED_ACTION_NOTICE_KO).toMatch(/실행된 작업은 없어요/);
    expect(UNSUPPORTED_ACTION_NOTICE_EN).toMatch(/Nothing was done/);
  });

  it('follows the Core reply language over the reply text, and falls back to the reply text, then to both', () => {
    expect(guardUnsupportedActionClaims("I've added the meeting to your calendar.", ko)).toBe(UNSUPPORTED_ACTION_NOTICE_KO);
    expect(guardUnsupportedActionClaims('캘린더에 추가해 드렸어요.')).toBe(UNSUPPORTED_ACTION_NOTICE_KO);
    expect(guardUnsupportedActionClaims('I sent the email.', undefined)).toBe(UNSUPPORTED_ACTION_NOTICE_EN);
    expect(guardUnsupportedActionClaims('カレンダーに追加しました。I have added it to your calendar.', ja)).toBe(
      `${UNSUPPORTED_ACTION_NOTICE_KO}\n\n${UNSUPPORTED_ACTION_NOTICE_EN}`,
    );
  });

  it('returns a reply without a claim unchanged', () => {
    const reply = '메일 초안이에요.\n\n안녕하세요, 일정 변경 건으로 연락드립니다.';
    expect(guardUnsupportedActionClaims(reply, ko)).toBe(reply);
  });

  it('runs inside sanitizeGeneralChatText after the existing hygiene steps', () => {
    expect(sanitizeGeneralChatText('네!\\n구글 캘린더에 회의를 추가해 드릴게요.\\n다른 일정도 말씀해 주세요.', ko)).toBe(UNSUPPORTED_ACTION_NOTICE_KO);
    expect(sanitizeGeneralChatText('안녕하세요!', ko)).toBe('안녕하세요!');
  });
});

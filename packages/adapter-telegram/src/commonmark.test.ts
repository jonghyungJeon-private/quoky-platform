import { describe, expect, it } from 'vitest';
import {
  clipMessage,
  composeDailyBrief,
  conversationRefOf,
  firstFit,
  fitLines,
  messageContent,
  messageLink,
  platformNote,
  renderMessageContent,
  ResponseComposer,
  takeLines,
  untrustedText,
} from '@quoky/core';
import type { CalendarEvent, ConnectorItem, MessageContent, MessagePart } from '@quoky/core';
import { telegramSegments, translateCommonMark, translateTelegramBody } from './commonmark';
import { chunkTelegramText, deliverTelegramText, TELEGRAM_CHUNK_LIMIT, TELEGRAM_MESSAGE_LIMIT } from './delivery';
import { renderOutboundForTelegram, renderTelegramContent, TELEGRAM_MARKUP, translatePreviewCopy } from './rendering';

/** Quoky copy (a string body) as Telegram plain text. */
const t = (text: string): string => renderTelegramContent(text);

describe('TG-3 CommonMark → Telegram plain text: the translations', () => {
  it('emphasis and strong emphasis lose their delimiters when they pair', () => {
    expect(t('**굵게** 그리고 *기울임*')).toBe('굵게 그리고 기울임');
    expect(t('**굵게**')).toBe('굵게');
    // Underscore emphasis is not translated at all (file names and dunder identifiers are too common).
    expect(t('__밑줄 굵게__ 그리고 _밑줄_')).toBe('__밑줄 굵게__ 그리고 _밑줄_');
    expect(t('***둘 다***')).toBe('둘 다');
    expect(t('**내 할 일** (3건)')).toBe('내 할 일 (3건)');
    expect(t('- **Title:** 배포')).toBe('• Title: 배포');
  });

  it('what is not emphasis stays: snake_case, arithmetic, a lone marker, an unclosed run', () => {
    expect(t('snake_case_name 과 file_name.ts')).toBe('snake_case_name 과 file_name.ts');
    expect(t('2 * 3 * 4 = 24')).toBe('2 * 3 * 4 = 24');
    expect(t('별표 하나 * 만')).toBe('별표 하나 * 만');
    expect(t('**닫히지 않음')).toBe('**닫히지 않음');
    expect(t('a**b')).toBe('a**b');
  });

  it('paths, identifiers, URLs, link destinations and code are never altered (Codex P2-1, P2-2)', () => {
    for (const same of [
      '__init__.py',
      'snake_case',
      'a_b_c.txt',
      'src/_x_/y.ts',
      '_draft_.ts',
      'https://x/**y**',
      'www.e.test/_a_/b',
      'file (https://e.test/_draft_/x)',
      'file (https://e.test/**x**/y)',
      '<https://e.test/_a_/b>',
      'C:\\dir\\_x_\\*y*.ts',
      '파일 `src/_x_/y.ts` 수정',
    ]) {
      expect(t(same).replace(/`/g, '')).toBe(same.replace(/`/g, ''));
    }
    expect(t('`**code**`')).toBe('**code**');
    // Codex delta P2: backticks inside a link destination or autolink are part of it and stay byte-identical.
    for (const exact of ['[file](https://e.test/`draft`/x)', '<https://e.test/`a`/b>', 'https://e.test/`a`/b 확인']) {
      expect(t(exact)).toBe(exact);
    }
    expect(t('[**굵게**](https://e.test/_a_/b)')).toBe('**굵게** (https://e.test/_a_/b)');
    expect(t('**굵게** `a.ts` _draft_.ts')).toBe('굵게 a.ts _draft_.ts');
  });

  it("composeWorkspaceApplied keeps an underscore path exactly (Codex P2-1 repro)", () => {
    const reply = new ResponseComposer().composeWorkspaceApplied({ platform: 'telegram', channelId: 'c', userId: 'u' }, ['_draft_.ts']);
    expect(reply.text).toContain('_draft_.ts');
    expect(renderOutboundForTelegram(reply)).toContain('_draft_.ts');
    expect(translatePreviewCopy({ previewId: 'p', header: 'h', warning: '⚠️ `_draft_.ts` __init__.py', footer: 'f', files: [], canonicalDiff: '', attachmentFilename: 'a.diff' }).warning).toBe(
      '⚠️ _draft_.ts __init__.py',
    );
  });

  it('code spans lose their backticks and keep their content literally (no emphasis inside)', () => {
    expect(t('`승인` 이라고 보내세요')).toBe('승인 이라고 보내세요');
    expect(t('`**not bold**` 와 `a_b_c`')).toBe('**not bold** 와 a_b_c');
    expect(t('`` a`b ``')).toBe('a`b');
    expect(t('짝 없는 ` 백틱')).toBe('짝 없는 ` 백틱');
  });

  it('headings become plain lines; bullets become •; ordered lists and breaks stay', () => {
    expect(t('# 제목\n## 부제 ##\n###### 작은 제목\n####### 일곱 개')).toBe('제목\n부제\n작은 제목\n####### 일곱 개');
    expect(t('#해시태그는 제목이 아님')).toBe('#해시태그는 제목이 아님');
    expect(t('- 하나\n* 둘\n+ 셋\n  - 안쪽')).toBe('• 하나\n• 둘\n• 셋\n  • 안쪽');
    expect(t('1. 첫째\n2. 둘째')).toBe('1. 첫째\n2. 둘째');
    expect(t('위\n---\n***\n아래')).toBe('위\n---\n***\n아래');
  });

  it('a fenced block loses its fence lines and keeps its content exactly (CommonMark closing rule)', () => {
    expect(t('설명:\n```diff\n- old **x**\n+ new # y\n```\n끝 **굵게**')).toBe('설명:\n- old **x**\n+ new # y\n끝 굵게');
    // A longer fence: a shorter run inside does not close it; a longer closer does.
    expect(t('````\n```\n`code`\n`````\n뒤')).toBe('```\n`code`\n뒤');
    expect(t('~~~\n**x**\n~~~')).toBe('**x**');
    // Unclosed: the content runs to the end, untranslated.
    expect(t('앞\n```\n**계속**')).toBe('앞\n**계속**');
    // A backtick info string with a backtick is not a fence (it is an inline code span).
    expect(t('```x```')).toBe('x');
  });

  it('a model reply is translated; its table is kept as written', () => {
    const reply = '## 요약\n\n**결론**: `pnpm test` 통과\n\n- 항목 _하나_\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(renderOutboundForTelegram({ text: reply, format: 'model-reply' } as never)).toBe(
      '요약\n\n결론: pnpm test 통과\n\n• 항목 _하나_\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
  });

  it('a preview keeps its diff and file name; only the header, warning and footer copy are translated', () => {
    const preview = {
      previewId: 'p',
      header: '**변경 미리보기** `a.ts`',
      warning: '⚠️ **범위 밖** 경로',
      footer: '적용하려면 `적용`',
      files: [],
      canonicalDiff: '+**x** `y`\n',
      attachmentFilename: 'a.diff',
    };
    expect(translatePreviewCopy(preview)).toEqual({
      ...preview,
      header: '변경 미리보기 a.ts',
      warning: '⚠️ 범위 밖 경로',
      footer: '적용하려면 적용',
    });
  });
});

describe('TG-3 follow-up: http(s) links and block quotes (v4 residual polish)', () => {
  it('[text](url) becomes "text (url)" for http(s) only; the URL stays plain text for Telegram to autolink', () => {
    expect(t('[문서](https://e.test/a?b=1&c=2#d)')).toBe('문서 (https://e.test/a?b=1&c=2#d)');
    expect(t('자세히는 [여기](http://e.test/x) 와 [저기](HTTPS://E.TEST/y) 를 봐요')).toBe('자세히는 여기 (http://e.test/x) 와 저기 (HTTPS://E.TEST/y) 를 봐요');
    expect(t('[위키](https://e.test/a_(b))')).toBe('위키 (https://e.test/a_(b))');
    expect(t('[https://e.test/x](https://e.test/x)')).toBe('https://e.test/x');
    expect(t('- [하나](https://e.test/1)\n- [둘](https://e.test/2)')).toBe('• 하나 (https://e.test/1)\n• 둘 (https://e.test/2)');
  });

  it('other schemes, titles, images, reference links, spaces and code spans stay as written', () => {
    for (const same of [
      '[x](javascript:alert(1))',
      '[x](ftp://e.test/a)',
      '[x](mailto:a@e.test)',
      '[x](/relative/path)',
      '[x](https://e.test/a "title")',
      '[x](https://e.test/a b)',
      '[x](<https://e.test/a>)',
      '![img](https://e.test/a.png)',
      '[ref][1]',
      '[](https://e.test/a)',
      '[x](https://e.test/a',
      '[a [b]](https://e.test/a)',
      // A backtick inside the destination makes part of it a code span: not a plain URL, so left as written.
      '[file](https://e.test/`draft`/x)',
    ]) {
      expect(t(same), same).toBe(same);
    }
    // A code span keeps its content literally (the backticks go, as before).
    expect(t('`[x](https://e.test/a)`')).toBe('[x](https://e.test/a)');
  });

  it('a link with an untrusted span in its text or destination is left alone; spans are byte-identical', () => {
    const hostile = '[**x**](https://evil.test/`a`)';
    const content = messageContent('[', untrustedText(hostile), '](https://e.test/a) · [ok](https://e.test/b) · [', untrustedText('t'), '](https://e.test/c) · [t](https://e.test/', untrustedText('d'), ')');
    const rendered = renderTelegramContent(content);
    expect(rendered).toContain(`[${hostile}](https://e.test/a)`);
    expect(rendered).toContain('ok (https://e.test/b)');
    expect(rendered).toContain('[t](https://e.test/c)');
    expect(rendered).toContain('[t](https://e.test/d)');
    // The untrusted span itself is never rewritten, even when it is a complete link.
    expect(renderTelegramContent(messageContent(untrustedText('[x](https://e.test/a)'), ' 끝'))).toBe('[x](https://e.test/a) 끝');
    expect(renderTelegramContent(messageContent('> ', untrustedText('> 인용 [x](https://e.test/a)')))).toBe('│ > 인용 [x](https://e.test/a)');
  });

  it('a model reply may carry links and quotes: the visible URL replaces a hidden destination', () => {
    const reply = renderOutboundForTelegram({ text: '> 요약\n> 두 번째 줄\n\n출처: [공식 문서](https://e.test/docs) 와 [그림](javascript:x)', format: 'model-reply' } as never);
    expect(reply).toBe('│ 요약\n│ 두 번째 줄\n\n출처: 공식 문서 (https://e.test/docs) 와 [그림](javascript:x)');
  });

  it('a leading "> " becomes "│ " (nested too, a lone > as │); a > elsewhere, or inside a fence, is untouched', () => {
    expect(t('> 인용')).toBe('│ 인용');
    expect(t('> > 중첩')).toBe('│ │ 중첩');
    expect(t('  > 들여쓴 인용')).toBe('  │ 들여쓴 인용');
    expect(t('>\n> 둘째')).toBe('│\n│ 둘째');
    for (const same of ['a > b', '2 > 1', '-> 화살표', '>붙여 쓴 것', '    > 코드 들여쓰기', '값 => 다음']) expect(t(same), same).toBe(same);
    expect(t('```\n> 코드 안\n```')).toBe('> 코드 안');
    expect(t('> **굵게** [링크](https://e.test/a)')).toBe('│ 굵게 링크 (https://e.test/a)'.replace('링크 (', '링크 ('));
  });

  it('the translation is never longer than the input, link and quote rewrites included', () => {
    for (const text of ['[a](https://e.test/x)', '> [a](https://e.test/x)', '[https://e.test](https://e.test)', '> > x\n[y](http://z.test)', '[a](https://e.test/x)'.repeat(50)]) {
      expect(t(text).length, text).toBeLessThanOrEqual(text.length);
    }
  });
});

describe('TG-3 translator safety: an untrusted span is never reinterpreted', () => {
  const HOSTILE = '**x** <b>b</b> `c` _i_ # h';

  it('an untrusted span keeps **x**, <b>, backticks, underscores and # as they are, under every guard', () => {
    for (const guard of ['markup', 'mentions', 'handles'] as const) {
      expect(renderTelegramContent(messageContent('제목: ', untrustedText(HOSTILE, guard)))).toBe(`제목: ${HOSTILE}`);
    }
  });

  it('Quoky markers around a span pair across it; the markers inside the span stay', () => {
    expect(renderTelegramContent(messageContent('**', untrustedText('**x**'), '**'))).toBe('**x**');
    expect(renderTelegramContent(messageContent('**Jira ', untrustedText('<b>b</b> *y*'), '** (2건)'))).toBe('Jira <b>b</b> *y* (2건)');
    expect(renderTelegramContent(messageContent('`', untrustedText('**x**'), '`'))).toBe('**x**');
  });

  it('a span never opens a fence, starts a heading or a list, or closes a marker', () => {
    const content = messageContent('앞\n', untrustedText('```\n# h\n- i\n**'), '\n**뒤** 와 *a*');
    expect(renderTelegramContent(content)).toBe('앞\n```\n# h\n- i\n**\n뒤 와 a');
    // A span at the start of a line is not a bullet, a heading or a fence either.
    expect(renderTelegramContent(messageContent('목록\n', untrustedText('- x'), '\n', untrustedText('# y'), '\n', untrustedText('```')))).toBe(
      '목록\n- x\n# y\n```',
    );
  });

  it('a span inside a fenced block of Quoky copy is kept with the block (and the block closes after it)', () => {
    const content = messageContent('```\n', untrustedText('**payload**'), '\n```\n**끝**');
    expect(renderTelegramContent(content)).toBe('**payload**\n끝');
  });

  it('links and conversation references are spans too: an underscore or a star in a URL stays', () => {
    const content = messageContent('**링크**: ', messageLink('https://e.test/a_b_c*d*'), ' · ', conversationRefOf({ platform: 'telegram', channelId: '1', userId: '1', direct: true }, { direct: '**이 DM**', channel: '채널' }));
    expect(renderTelegramContent(content)).toBe('링크: https://e.test/a_b_c*d* · **이 DM**');
  });

  it('fail safe: when the segment evaluator disagrees with Core, nothing is translated', () => {
    expect(translateTelegramBody('**x**', TELEGRAM_MARKUP, 'not the same')).toBe('not the same');
  });
});

/** A deterministic pseudo-random generator (mulberry32). */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ['**', '*', '_', '`', '```', '\n', '# ', '- ', ' ', '가나', 'abc', '😀', '<b>', '~~~', '…', '\n```\n', 'x_y', '  ', '> ', '[a](https://e.test/x)', '[', '](https://e.test/', ')'];

function randomText(next: () => number): string {
  let text = '';
  const count = 1 + Math.floor(next() * 8);
  for (let i = 0; i < count; i += 1) text += PIECES[Math.floor(next() * PIECES.length)] as string;
  return text;
}

function randomContent(next: () => number, depth: number): MessageContent {
  const parts: MessagePart[] = [];
  const count = 1 + Math.floor(next() * 5);
  for (let i = 0; i < count; i += 1) {
    const pick = Math.floor(next() * (depth > 2 ? 4 : 9));
    const sub = (): MessageContent => randomContent(next, depth + 1);
    const max = 1 + Math.floor(next() * 40);
    const unit = next() < 0.5 ? ('utf16' as const) : ('code-points' as const);
    if (pick === 0) parts.push(randomText(next));
    else if (pick === 1) parts.push(untrustedText(randomText(next)));
    else if (pick === 2) parts.push(messageLink(`https://e.test/${randomText(next).replace(/\s/g, '')}`));
    else if (pick === 3) parts.push(platformNote('command-prefix'));
    else if (pick === 4) parts.push(clipMessage(sub(), max, unit, { trim: next() < 0.5, ...(next() < 0.5 ? { after: sub() } : {}) }));
    else if (pick === 5) parts.push(fitLines([{ content: sub() }, { content: sub(), droppable: true }, { content: sub(), droppable: true }], max, next() < 0.5 ? '(생략)' : undefined));
    else if (pick === 6)
      parts.push(
        takeLines({
          unit,
          maxChars: max + 10,
          baseChars: Math.floor(next() * 5),
          head: [sub()],
          tail: next() < 0.5 ? [sub()] : [],
          lines: [{ content: sub(), item: true }, { content: sub() }, { content: sub(), item: true }],
          headOnlyWithLines: next() < 0.5,
          dropTrailingHeadings: next() < 0.5,
          ...(next() < 0.5 ? { omitted: { hidden: Math.floor(next() * 3), before: '외 ', after: '건' } } : {}),
        }),
      );
    else if (pick === 7) parts.push(firstFit([sub(), sub()], max, unit));
    else parts.push(conversationRefOf({ platform: next() < 0.5 ? 'telegram' : 'discord', channelId: '9', userId: '1', direct: next() < 0.5 }, { direct: '이 DM', channel: '이 채널' }));
  }
  return messageContent(...parts);
}

describe("TG-3 translator plumbing: the segment evaluator is Core's, and translation never lengthens", () => {
  it('600 random content trees: the segments concatenate to exactly the Core rendering; the translation is never longer', () => {
    const next = prng(20261012);
    for (let i = 0; i < 600; i += 1) {
      const content = randomContent(next, 0);
      const rendered = renderMessageContent(content, TELEGRAM_MARKUP);
      const segments = telegramSegments(content, TELEGRAM_MARKUP);
      expect(segments.map((segment) => segment.text).join(''), `tree ${i}`).toBe(rendered);
      const translated = translateCommonMark(segments);
      expect(translated.length, `tree ${i}`).toBeLessThanOrEqual(rendered.length);
      // Every untrusted span's text survives somewhere in the output exactly (it is never edited).
      for (const segment of segments) if (segment.span) expect(translated, `tree ${i}`).toContain(segment.text);
      // No URL-shaped or path-shaped token of the copy is ever changed (except a `[text](http…)` link, rewritten on purpose).
      for (const token of rendered.split(/\s+/)) {
        if (/\]\(https?:\/\//i.test(token)) continue;
        if (/:\/\/|^www\.|[/\\]|\.[A-Za-z0-9]+$|^[A-Za-z0-9.-]*_[A-Za-z0-9_.-]*$/.test(token) && !/[`*]/.test(token.replace(/^[`*]+|[`*]+$/g, ''))) {
          expect(translated, `tree ${i} token ${token}`).toContain(token.replace(/^[`*]+|[`*]+$/g, ''));
        }
      }
    }
  });

  it('a real Core renderer (the morning brief with calendar and Jira sections) keeps parity and its untrusted titles', () => {
    const title = '**버그** `fix` _now_ <b>x</b>';
    const calendarEvent: CalendarEvent = {
      id: 'e1',
      title,
      start: '2026-10-02T01:00:00.000Z',
      end: '2026-10-02T01:30:00.000Z',
      allDay: false,
      status: 'confirmed',
      calendarName: 'primary',
    };
    const body = composeDailyBrief({
      now: '2026-10-01T23:00:00.000Z',
      timeZone: 'Asia/Seoul',
      reminders: [],
      workItems: [],
      calendar: { events: [calendarEvent], limit: 50 },
      assignedWork: [{ id: 'P-1', title, dueDate: '2026-10-02' } as ConnectorItem],
    });
    const rendered = renderMessageContent(body, TELEGRAM_MARKUP);
    expect(telegramSegments(body, TELEGRAM_MARKUP).map((segment) => segment.text).join('')).toBe(rendered);
    const telegram = renderTelegramContent(body);
    // Both titles (calendar and Jira) are untrusted spans: delivered exactly, markers and all.
    expect(telegram.split(title).length - 1).toBe(2);
    expect(telegram.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });
});

describe('TG-3 chunking after translation stays lossless (ADR-0114 D7)', () => {
  const reply = Array.from({ length: 400 }, (_, i) => `## 절 ${i}\n**굵게 ${i}** 그리고 \`코드 ${i}\` [문서 ${i}](https://e.test/d/${i})\n> 인용 ${i}\n- 항목 ${i}\n\`\`\`\n코드 줄 ${i} **그대로** > [그대로](https://e.test/${i})\n\`\`\``).join('\n');

  it('the translated text is split into ≤4096 chunks that join back to exactly the translated text', async () => {
    const translated = renderOutboundForTelegram({ text: reply, format: 'model-reply' } as never);
    expect(translated.length).toBeLessThan(reply.length);
    expect(translated).toContain('코드 줄 7 **그대로** > [그대로](https://e.test/7)');
    expect(translated).toContain('**굵게 7**'.replace(/\*/g, '') + ' 그리고');
    expect(translated).toContain('문서 7 (https://e.test/d/7)');
    expect(translated).toContain('│ 인용 7');
    expect(translated).not.toContain('```');
    const chunks = chunkTelegramText(translated);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(translated);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);

    const sent: string[] = [];
    const report = await deliverTelegramText(translated, async (chunk) => void sent.push(chunk), async () => undefined, () => 'X');
    expect(report).toMatchObject({ ok: true, totalChunks: chunks.length });
    for (const message of sent) expect(message.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(sent.map((message, index) => message.slice(`(${index + 1}/${sent.length}) `.length)).join('')).toBe(translated);
  });
});

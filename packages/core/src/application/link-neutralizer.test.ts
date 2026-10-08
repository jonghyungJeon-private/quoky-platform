import { describe, expect, it } from 'vitest';
import { LINK_PLACEHOLDER, containsLink, neutralizeLinks } from './link-neutralizer';
import { PLAIN_TEXT_MARKUP, renderMessageContent } from './message-rendering';
import { buildUntrustedDocumentReadout, documentSummaryReplyBody, isSummarizableDocumentReadout } from './untrusted-document-readout';

/** URL-shaped tokens the re-review listed (and more), each with what must remain around it. */
const BYPASSES = [
  '1https://evil.example/login',
  '_https://evil.example/b',
  'x.https://evil.example/c',
  'HTTPS://EVIL.EXAMPLE/D',
  'hTtP://evil.example',
  'ftp://evil.example/file',
  'hxxp://evil.example/defanged-scheme',
  'www.evil.co',
  'WWW.EVIL.CO/x',
  'evil.example/login',
  'evil.example:8443/x',
  'login.evil.com',
  'xn--80ak6aa92e.com/pay',
  'evil.xn--p1ai',
  'пример.рф',
  '예시.한국/로그인',
  'аpple.com',
  '한글도메인.com',
  // Sign-off item 1: file-extension-looking country TLDs are links in both modes.
  'evil.sh',
  'login-verify.md',
  'evil.rs',
  'paypal.com.py',
];

/** A broad "scheme or domain" detector, independent of the neutralizer's own patterns. */
const BROAD = /[a-z][a-z0-9+.-]*:\/\/|www\.|(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+|рф|한국)(?![\p{L}\p{N}-])/iu;

describe('neutralizeLinks (GML-1 re-review item 1)', () => {
  it.each(BYPASSES)('display mode replaces %s, glued or not', (link) => {
    for (const text of [link, `확인: ${link} 하세요`, `(${link})`, `[click](${link})`, `${link}.`, `가${link}`]) {
      const out = neutralizeLinks(text);
      expect(out, text).toContain(LINK_PLACEHOLDER);
      expect(BROAD.test(out), `${text} → ${out}`).toBe(false);
    }
  });

  it('body mode replaces every scheme URL, www host and domain with a path or a web TLD', () => {
    for (const link of BYPASSES.filter((entry) => !/^(?:пример\.рф|аpple\.com|한글도메인\.com)$/u.test(entry))) {
      expect(neutralizeLinks(`see ${link} now`, 'body'), link).toContain(LINK_PLACEHOLDER);
    }
    expect(neutralizeLinks('see example.org or evil.zip', 'body')).toBe(`see ${LINK_PLACEHOLDER} or ${LINK_PLACEHOLDER}`);
    // Sign-off item 1: a country TLD that looks like a file extension is a link in body mode too; README.md included.
    for (const link of ['evil.sh', 'login-verify.md', 'evil.rs', 'paypal.com.py', 'README.md']) {
      expect(neutralizeLinks(`see ${link} now`, 'body'), link).toBe(`see ${LINK_PLACEHOLDER} now`);
      expect(neutralizeLinks(`see ${link} now`), link).toBe(`see ${LINK_PLACEHOLDER} now`);
    }
  });

  it('sign-off item 2: a Korean particle glued to the domain does not hide it, in either mode', () => {
    for (const [text, expected] of [
      ['evil.com에서 확인', `${LINK_PLACEHOLDER}에서 확인`],
      ['naver.com은 안전해요', `${LINK_PLACEHOLDER}은 안전해요`],
      ['evil.co.kr로 접속', `${LINK_PLACEHOLDER}로 접속`],
      ['site.io를 여세요', `${LINK_PLACEHOLDER}를 여세요`],
    ] as const) {
      expect(neutralizeLinks(text), text).toBe(expected);
      expect(neutralizeLinks(text, 'body'), text).toBe(expected);
    }
  });

  it('keeps ordinary text: versions, abbreviations, e-mail addresses, file names and sentence ends', () => {
    for (const text of [
      'v1.2.3 이후 버전',
      '1.2.3',
      'e.g. this, i.e. that',
      'U.S. office',
      'kim@example.com',
      'report.pdf 와 index.ts 를 보세요',
      '보고서.pdf 첨부',
      '확인했습니다. 다음 주에 뵙겠습니다.',
      '3.5배 증가',
    ]) {
      expect(neutralizeLinks(text), text).toBe(text);
    }
    // In body mode an unlisted TLD without a path is a word, so a technical mail keeps "Node.js".
    expect(neutralizeLinks('Node.js 와 Vue.js', 'body')).toBe('Node.js 와 Vue.js');
    // Known trade-off: in display mode a word-dot-word that looks like a domain is replaced.
    expect(neutralizeLinks('Mr.Kim')).toBe(LINK_PLACEHOLDER);
  });

  it('sign-off item 4: IDN TLDs, combining marks, format characters and ideographic full stops are caught', () => {
    for (const text of [
      'evil.ком',
      'пример.орг/login',
      'shop.公司',
      'café.com',
      'cafe\u0301.com',
      'evil\u200b.com',
      'ev\u00adil.com/x',
      'evil。com',
      'evil．com',
      'ｅｖｉｌ．ｃｏｍ',
      'ｈｔｔｐｓ://evil.example',
    ]) {
      for (const mode of ['display', 'body'] as const) {
        const out = neutralizeLinks(`확인 ${text} 하세요`, mode);
        expect(out, `${mode} ${text}`).toBe(`확인 ${LINK_PLACEHOLDER} 하세요`);
      }
    }
    // Japanese and Chinese sentences keep their full stops.
    expect(neutralizeLinks('会議は明日です。よろしく')).toBe('会議は明日です。よろしく');
  });

  it('does not catch defanged forms (they are not clickable either; documented)', () => {
    expect(neutralizeLinks('hxxp[:]//evil[.]example')).toBe('hxxp[:]//evil[.]example');
  });

  it('property: after display-mode neutralization no URL-shaped token survives (2,000 seeded cases)', () => {
    let seed = 0x5eed;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(items: readonly T[]) => items[next(items.length)] as T;
    const schemes = ['https://', 'HTTP://', 'hxxp://', 'ftp://', 'x.https://', 'git+ssh://', 'www.', ''];
    const labels = ['evil', 'login-secure', 'a1', 'xn--80ak6aa92e', 'пример', '예시', 'ex4mple', 'b'];
    const tlds = ['com', 'example', 'co', 'XN--P1AI', 'рф', '한국', 'online', 'io'];
    const prefixes = ['', ' ', '1', '_', '가', '(', '[x](', '"', '.', '-'];
    const suffixes = ['', '/', '/login?x=1', ':8080', '.', ')', '#frag', '가', ' 확인'];
    for (let i = 0; i < 2_000; i += 1) {
      const host = Array.from({ length: 1 + next(3) }, () => pick(labels)).join('.');
      const token = `${pick(prefixes)}${pick(schemes)}${host}.${pick(tlds)}${pick(suffixes)}`;
      const text = `${pick(['', '안내 ', 'Please ', '확인:'])}${token}${pick(['', ' 지금', '. 감사합니다'])}`;
      const out = neutralizeLinks(text);
      expect(BROAD.test(out), `${text} → ${out}`).toBe(false);
      expect(containsLink(out)).toBe(false);
    }
  });

  it('is linear on hostile input', () => {
    for (const text of ['a.'.repeat(130_000), `${'a'.repeat(250_000)}.com`, 'www.'.repeat(60_000), 'https://'.repeat(30_000), '-.'.repeat(100_000)]) {
      const start = performance.now();
      neutralizeLinks(text, 'body');
      neutralizeLinks(text);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it('every route uses it: readout body, title, author, the re-check and the reply', () => {
    for (const link of ['1https://evil.example/login', '_https://evil.example/b', 'evil.example/login', 'xn--80ak6aa92e.com/pay']) {
      const built = buildUntrustedDocumentReadout({
        source: 'mail',
        title: `안내 ${link}`,
        author: `보안팀 ${link}`,
        date: '2026-10-08T00:00:00Z',
        body: `계정을 확인하세요: ${link}`,
      });
      if (!built.ok) throw new Error(`expected a readout for ${link}`);
      for (const field of [built.readout.title, built.readout.author, built.readout.body]) {
        expect(field, link).toContain(LINK_PLACEHOLDER);
        expect(BROAD.test(field), `${link} → ${field}`).toBe(false);
      }
      // The re-check refuses a readout that still carries the link, in any field.
      for (const key of ['title', 'author', 'body'] as const) {
        expect(isSummarizableDocumentReadout({ ...built.readout, [key]: `x ${link}` }), `${key} ${link}`).toBe(false);
      }
      const reply = renderMessageContent(documentSummaryReplyBody(`요약: ${link} 를 누르라는 메일이에요.`, '(f)'), PLAIN_TEXT_MARKUP);
      expect(reply, link).toContain(LINK_PLACEHOLDER);
      expect(BROAD.test(reply), `${link} → ${reply}`).toBe(false);
    }
  });
});

describe('final sign-off W-2: CJK sentences are not read as IDN hosts', () => {
  it.each([
    ['ご確認ください。ポイント：3つ'],
    ['ありがとう。みんな！'],
    ['请带好。手机，钥匙'],
    ['会议结束。信息如下'],
  ])('%s is left unchanged in both modes', (text) => {
    for (const mode of ['display', 'body'] as const) {
      expect(neutralizeLinks(text, mode)).not.toContain(LINK_PLACEHOLDER);
    }
  });

  it('an IDN TLD after an ASCII full stop, and an ASCII TLD after an ideographic one, are still replaced', () => {
    for (const mode of ['display', 'body'] as const) {
      expect(neutralizeLinks('예시.한국 에서 확인', mode)).toContain(LINK_PLACEHOLDER);
      expect(neutralizeLinks('shop.ポイント 확인', mode)).toContain(LINK_PLACEHOLDER);
      expect(neutralizeLinks('evil。com/login', mode)).toContain(LINK_PLACEHOLDER);
    }
  });
});

describe('Codex final delta: a Korean particle after an IDN TLD', () => {
  it.each([['shop.한국에서 확인하세요'], ['예시.한국은 안전해요'], ['evil.닷컴으로 접속']])('%s is replaced in both modes', (text) => {
    for (const mode of ['display', 'body'] as const) {
      const out = neutralizeLinks(text, mode);
      expect(out, `${mode} ${text}`).toContain(LINK_PLACEHOLDER);
      expect(out).not.toMatch(/한국|닷컴/u);
    }
  });
});

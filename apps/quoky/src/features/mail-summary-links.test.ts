import { describe, expect, it } from 'vitest';
import { renderDiscordContent } from '@quoky/adapter-discord';
import { documentSummaryReplyBody } from '@quoky/core';

// Review P2-4: a phishing mail's masked link, echoed by the model, must not become a clickable link in the bot's reply.
describe('document summary reply on Discord (review P2-4)', () => {
  it('a masked link and bare URLs from a phishing mail render as inert text', () => {
    const providerText =
      '보안 경고: [계정 확인하기](https://evil.example/login?next=%2F) 를 누르라는 메일이에요. ' +
      '<https://evil.example/a> https://evil.example/b www.evil.example [x](evil.example)';
    const discord = renderDiscordContent(documentSummaryReplyBody(providerText, '(메일 1건의 본문을 대화 모델에 보내 요약했어요)'));
    expect(discord).not.toMatch(/https?:\/\//);
    expect(discord).not.toContain('www.');
    // Markdown link syntax is escaped, so no masked link can render (`\[…\]\(…\)` is literal text on Discord).
    expect(discord).toContain('\\[계정 확인하기\\](\\[링크\\])');
    expect(discord).not.toMatch(/(?<!\\)\[[^\]]*(?<!\\)\]\(/);
    expect(discord.endsWith('(메일 1건의 본문을 대화 모델에 보내 요약했어요)')).toBe(true);
  });

  it('re-review item 1: glued, upper-case, bare and IDN links in the reply render as no URL on Discord', () => {
    const providerText =
      '1https://evil.example/login _https://evil.example/b x.https://evil.example HTTPS://EVIL.EXAMPLE ' +
      'evil.example/login xn--80ak6aa92e.com 예시.한국 www.evil.co 를 누르라는 메일이에요.';
    const discord = renderDiscordContent(documentSummaryReplyBody(providerText, '(f)'));
    expect(discord).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/|www\.|evil|xn--|예시\.한국/i);
  });
});

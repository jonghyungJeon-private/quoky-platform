import { describe, expect, it } from 'vitest';
import { renderDiscordContent } from '@quoky/adapter-discord';
import { documentSummaryReplyBody, renderDriveSummaryFooter } from '@quoky/core';

// The GML-1 review P2-4 rule for a Drive summary: a hostile document's masked link, echoed by the model, must not become
// a clickable link in the bot's reply (the reply is an untrusted span, never a model reply).
describe('Drive document summary reply on Discord', () => {
  it('a masked link and bare, glued, IDN and full-stop-variant URLs render as inert text; the fixed footer is appended', () => {
    const providerText =
      '보안 경고: [계정 확인하기](https://evil.example/login?next=%2F) 를 누르라는 문서예요. ' +
      '<https://evil.example/a> 1https://evil.example/b www.evil.example evil.example/login xn--80ak6aa92e.com 예시.한국 ' +
      'evil.com에서 evil。com [x](evil.example)';
    const discord = renderDiscordContent(documentSummaryReplyBody(providerText, renderDriveSummaryFooter('ko')));
    expect(discord).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/|www\.|evil|xn--|예시\.한국/i);
    expect(discord).toContain('\\[계정 확인하기\\](\\[링크\\])');
    expect(discord).not.toMatch(/(?<!\\)\[[^\]]*(?<!\\)\]\(/);
    expect(discord.endsWith(renderDriveSummaryFooter('ko'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { PLT1_VARIANTS, ResponseComposer, plainTextOf, plt1OverflowReplies, plt1Replies } from '@quoky/core';
import type { Plt1Variant } from '@quoky/core';
import type { ConversationContext, MessageBody, OutboundMessage } from '@quoky/core';
import { renderOutboundForTelegram, renderTelegramContent, translatePreviewCopy } from './rendering';
import { translateCommonMark } from './commonmark';

/**
 * PLT-1 on Telegram (plain text, no parse mode): an outside value in a Core reply is an untrusted span, which the TG-3
 * translation never alters. Before PLT-1 these replies put the path into Quoky copy, where a `_draft_.ts` lost its
 * underscores. The same corpus is rendered on Discord by `adapter-discord/src/rendering-golden.test.ts`.
 */


const composer = new ResponseComposer();
const CTX: ConversationContext = { platform: 'telegram', channelId: '5550001', userId: '5550001', direct: true };

/** Every hostile value of the `nasty` variant (paths, branch, repository, commit message, URL), exactly as given. */
const nasty = PLT1_VARIANTS.find((variant) => variant.id === 'nasty') as Plt1Variant;
const HOSTILE_VALUES = [...nasty.paths, nasty.branch, nasty.message, nasty.url, `${nasty.owner}/${nasty.repo}`];

function textOf(reply: OutboundMessage | MessageBody): string {
  return typeof reply === 'string' || Array.isArray(reply) ? renderTelegramContent(reply as MessageBody) : renderOutboundForTelegram(reply as OutboundMessage);
}

describe('PLT-1: outside values reach Telegram verbatim', () => {
  it('a path with `_x_` and `*y*` survives a converted reply unchanged', () => {
    const reply = composer.composeWorkspaceApplied(CTX, ['src/_x_/*y*.ts', '_draft_.ts', '*y*'], ['_draft_.ts']);
    const text = renderOutboundForTelegram(reply);
    expect(text).toContain('파일을 수정했어요: src/_x_/*y*.ts, _draft_.ts (새 파일), *y*');
  });

  it('the same path written as plain copy loses its markers (what PLT-1 fixes)', () => {
    expect(translateCommonMark([{ text: '파일을 수정했어요: *y*, a.ts', span: false }])).toBe('파일을 수정했어요: y, a.ts');
  });

  it('every hostile value that a reply names reaches Telegram exactly as given', () => {
    const lost: string[] = [];
    let named = 0;
    for (const [id, reply] of plt1Replies(composer, nasty)) {
      const plain = typeof reply === 'string' || Array.isArray(reply) ? plainTextOf(reply as MessageBody) : (reply as OutboundMessage).text;
      const telegram = textOf(reply);
      for (const value of HOSTILE_VALUES) {
        if (!plain.includes(value)) continue;
        named += 1;
        if (!telegram.includes(value)) lost.push(`${id}: ${value}`);
      }
    }
    expect(named).toBeGreaterThan(100);
    expect(lost).toEqual([]);
  });

  it('an ordinary reply is delivered as before: Quoky copy translated, nothing else touched', () => {
    for (const [id, reply] of plt1Replies(composer, PLT1_VARIANTS[0] as Plt1Variant)) {
      const text = textOf(reply);
      expect(text.trim().length, id).toBeGreaterThan(0);
      expect(text, id).not.toMatch(/\\[_*[\]]/);
    }
  });
});

describe('PLT-1 review fixes on Telegram', () => {
  it('P2-1: the fixed tail of a bounded reply is kept whole and the corpus replies fit the budget', () => {
    for (const [id, reply] of plt1OverflowReplies(composer)) {
      const text = renderOutboundForTelegram(reply);
      expect(text.length, id).toBeLessThanOrEqual(1900);
      expect(text.trimEnd().split('\n').pop(), id).toBe(reply.text.trimEnd().split('\n').pop());
    }
  });

  it('P2-2: the structured preview artifact keeps an outside path literal after the Telegram translation', () => {
    const hostile = ['*secret*/a.ts', '[확인](https://evil.example)'];
    const reply = composer.composeCodeDiffPreview(
      CTX,
      {
        changes: [{ path: 'src/a.ts', kind: 'update', unified: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n', binary: false }],
        outOfScopeWarnings: hostile,
      },
      { credentialOverrideSentPaths: hostile },
    );
    const translated = translatePreviewCopy(reply.preview as NonNullable<OutboundMessage['preview']>);
    for (const text of [translated.warning as string, translated.header]) {
      expect(text).toContain('*secret*/a.ts');
      expect(text).toContain('[확인](https://evil.example)');
    }
  });
});

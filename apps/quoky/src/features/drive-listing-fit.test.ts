import { describe, expect, it } from 'vitest';
import { renderOutboundForDiscord } from '@quoky/adapter-discord';
import {
  DRIVE_REPLY_MAX_CHARS,
  createDriveTurnHandler,
  type ConversationContext,
  type DriveFileSummary,
  type DriveReader,
  type TurnHandlerContext,
} from '@quoky/core';

// The GML-1 review P2 rule for Drive: on the real platform markups every listed entry is displayed, so a number always
// names an entry the owner saw, and no link from a hostile file name reaches Discord or Telegram.

const NOW = '2026-10-08T01:00:00.000Z';
const DM: ConversationContext = { platform: 'discord', channelId: 'dm', userId: 'u', direct: true };
/** Every character is one Discord escapes (Markdown characters, `@`, `<`). */
const HOSTILE = '*_~`|>[]@<\\'.repeat(40);

function file(index: number, name = `${index}${HOSTILE}`): DriveFileSummary {
  return { id: `id${index}`, name, kind: 'presentation', modifiedAt: '2025-12-30T05:00:00.000Z' };
}

function ctx(text: string): TurnHandlerContext {
  return {
    message: { id: 'm', context: DM, text, receivedAt: NOW },
    session: { id: 's' },
    actor: { id: 'a' },
    now: NOW,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  } as unknown as TurnHandlerContext;
}

function reader(files: readonly DriveFileSummary[], exported: string[] = []): DriveReader {
  const result = async () => ({ files, matched: 100, matchedIsLowerBound: true });
  return {
    source: 'drive',
    readOnly: true,
    searchByName: result,
    recentFiles: result,
    exportText: async (id) => {
      exported.push(id);
      return { ...file(Number(id.slice(2))), kind: 'document', id, ownerName: '', text: '본문', textTruncated: false };
    },
  };
}

describe('Drive listing on the real platform markups', () => {
  it('Discord escaping of long hostile names keeps all 10 entries in the message, and every number maps to a shown entry', async () => {
    const exported: string[] = [];
    const files = Array.from({ length: 10 }, (_, i) => ({ ...file(i + 1), kind: 'document' as const }));
    const handler = createDriveTurnHandler({ reader: reader(files, exported), timeZone: 'Asia/Seoul' });
    for (const query of ['드라이브에서 회의록 찾아줘', 'recent documents']) {
      const listing = await handler.handle(ctx(query));
      if (listing === null || !('reply' in listing)) throw new Error('expected a listing reply');
      const discord = renderOutboundForDiscord(listing.reply);
      for (const rendered of [discord, listing.reply.text]) {
        expect(Array.from(rendered).length).toBeLessThanOrEqual(DRIVE_REPLY_MAX_CHARS);
        for (let n = 1; n <= 10; n += 1) expect(rendered, `entry ${n}`).toMatch(new RegExp(`^${n}\\. `, 'm'));
      }
      expect(discord).toContain('\\*\\_\\~');
    }
    expect((await handler.handle(ctx('10번 문서 요약해줘')))?.kind).toBe('summarize');
    expect(exported).toEqual(['id10']);
    const outside = await handler.handle(ctx('11번 문서 요약해줘'));
    expect(outside !== null && 'reply' in outside ? outside.reply.text : '').toContain('"1번 문서 요약해줘"');
    expect(exported).toEqual(['id10']);
  });

  it('no URL from a file name or the echoed name query reaches the Discord markup or the Telegram plain text', async () => {
    const links = ['https://evil.co/x', '1https://evil.example/login', 'www.evil.co', 'evil.example/login', 'xn--80ak6aa92e.com', '예시.한국', 'evil.com에서', 'login-verify.md', 'evil。com'];
    const files = links.map((link, index) => file(index, `보안팀 ${link} 확인`));
    const handler = createDriveTurnHandler({ reader: reader(files), timeZone: 'Asia/Seoul' });
    const listing = await handler.handle(ctx('드라이브에서 evil.example 찾아줘'));
    if (listing === null || !('reply' in listing)) throw new Error('expected a listing reply');
    for (const rendered of [renderOutboundForDiscord(listing.reply), listing.reply.text]) {
      expect(rendered).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/|www\.|evil|xn--|예시\.한국|login-verify/i);
      expect(rendered).toContain('링크');
    }
    // Ordinary file names stay readable.
    const plain = createDriveTurnHandler({ reader: reader([file(1, '2026 예산 v1.2.3 report.pdf')]), timeZone: 'Asia/Seoul' });
    const kept = await plain.handle(ctx('최근 문서'));
    expect(kept !== null && 'reply' in kept ? kept.reply.text : '').toContain('1. 2026 예산 v1.2.3 report.pdf · 프레젠테이션');
  });
});

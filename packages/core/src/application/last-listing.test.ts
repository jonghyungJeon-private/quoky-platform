import { describe, expect, it } from 'vitest';
import type { ConversationContext, Session } from '../domain';
import { SessionStatus } from '../domain';
import type { StorageProvider } from '../ports';
import type { TurnHandlerContext, TurnHandlerOutcome } from '../ports/conversation-turn-handler.port';
import type { DriveReader } from '../ports/drive-reader.port';
import type { MailReader } from '../ports/mail-reader.port';
import { createDriveTurnHandler } from './drive/drive-turn-handler';
import { LAST_LISTING_METADATA_KEY, LAST_LISTING_TTL_MS } from './last-listing';
import { createMailTurnHandler } from './mail/mail-turn-handler';
import { SessionManager } from './session-manager';

const NOW = '2026-10-08T01:00:00.000Z';
const DM: ConversationContext = { platform: 'telegram', channelId: 'dm-1', userId: 'u-1', direct: true };
const SUBJECT = '극비 인수합병 제안서';
const FILE_NAME = '비밀 재무제표';
const SENDER = 'ceo@example.com';

/** The shared session store a restart does not lose: a minimal in-memory `sessions` repository. */
function store() {
  const rows = new Map<string, Session>();
  rows.set('s-1', {
    id: 's-1',
    actorId: 'a-1',
    context: DM,
    status: SessionStatus.ACTIVE,
    createdAt: NOW,
    lastActivityAt: NOW,
  } as Session);
  const storage = {
    sessions: {
      get: async (id: string) => rows.get(id) ?? null,
      save: async (session: Session) => {
        rows.set(session.id, structuredClone(session));
        return session;
      },
    },
  } as unknown as StorageProvider;
  return { rows, manager: new SessionManager(storage) };
}

function ctxOf(rows: Map<string, Session>, text: string, now = NOW, actor = 'a-1'): TurnHandlerContext {
  return {
    message: { id: 'm-1', context: DM, text, receivedAt: now },
    session: structuredClone(rows.get('s-1') as Session),
    actor: { id: actor } as TurnHandlerContext['actor'],
    now,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  };
}

function mailReader(gets: string[]): MailReader {
  const summary = (id: string) => ({
    id,
    sender: { name: '김철수', address: SENDER },
    subject: SUBJECT,
    receivedAt: '2026-10-08T00:12:00.000Z',
    snippet: '본문 미리보기',
    unread: true,
  });
  return {
    source: 'mail',
    readOnly: true,
    search: async () => ({ messages: [summary('gm-1'), summary('gm-2')], matched: 2, matchedIsLowerBound: false }),
    getMessage: async (id) => {
      gets.push(id);
      return { ...summary(id), bodyText: '본문입니다.', bodyTruncated: false };
    },
  };
}

function driveReader(exports: string[]): DriveReader {
  const file = (id: string) => ({ id, name: FILE_NAME, kind: 'document' as const, modifiedAt: '2026-10-08T00:12:00.000Z' });
  return {
    source: 'drive',
    readOnly: true,
    searchByName: async () => ({ files: [file('gd-1')], matched: 1, matchedIsLowerBound: false }),
    recentFiles: async () => ({ files: [file('gd-1'), file('gd-2')], matched: 2, matchedIsLowerBound: false }),
    exportText: async (id) => {
      exports.push(id);
      return { ...file(id), ownerName: '김철수', text: '본문입니다.', textTruncated: false };
    },
  };
}

const kindOf = (outcome: TurnHandlerOutcome | null) => outcome?.kind ?? 'reply';
const replyText = (outcome: TurnHandlerOutcome | null) => (outcome !== null && outcome.kind !== 'summarize' && outcome.kind !== 'write-draft' ? outcome.reply.text : '');

describe('persisted last listing (GML-1 / DRV-1 residual)', () => {
  it('mail: list, restart (new handler, same session store), then "1번 메일 요약해줘" reads the right id', async () => {
    const { rows, manager } = store();
    const gets: string[] = [];
    const before = createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul', sessions: manager });
    await before.handle(ctxOf(rows, '안 읽은 메일'));

    const after = createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul', sessions: manager });
    const later = '2026-10-08T01:10:00.000Z';
    expect(kindOf(await after.handle(ctxOf(rows, '2번 메일 요약해줘', later)))).toBe('summarize');
    expect(gets).toEqual(['gm-2']);
  });

  it('drive: list, restart, then "1번 문서 요약해줘" exports the right id', async () => {
    const { rows, manager } = store();
    const exports: string[] = [];
    await createDriveTurnHandler({ reader: driveReader(exports), timeZone: 'Asia/Seoul', sessions: manager }).handle(ctxOf(rows, '최근 문서'));
    const after = createDriveTurnHandler({ reader: driveReader(exports), timeZone: 'Asia/Seoul', sessions: manager });
    expect(kindOf(await after.handle(ctxOf(rows, '2번 문서 요약해줘', '2026-10-08T01:05:00.000Z')))).toBe('summarize');
    expect(exports).toEqual(['gd-2']);
  });

  it('without a session store the listing is memory-only and a new handler has nothing to resolve', async () => {
    const { rows } = store();
    const gets: string[] = [];
    await createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul' }).handle(ctxOf(rows, '안 읽은 메일'));
    const after = createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul' });
    expect(kindOf(await after.handle(ctxOf(rows, '1번 메일 요약해줘')))).toBe('reply');
    expect(gets).toEqual([]);
  });

  it('the 30-minute TTL is checked on read', async () => {
    const { rows, manager } = store();
    const gets: string[] = [];
    await createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul', sessions: manager }).handle(ctxOf(rows, '안 읽은 메일'));
    const restarted = createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul', sessions: manager });
    const justInside = new Date(Date.parse(NOW) + LAST_LISTING_TTL_MS - 1).toISOString();
    const expired = new Date(Date.parse(NOW) + LAST_LISTING_TTL_MS).toISOString();
    expect(kindOf(await restarted.handle(ctxOf(rows, '1번 메일 요약해줘', justInside)))).toBe('summarize');
    gets.length = 0;
    const answer = await restarted.handle(ctxOf(rows, '1번 메일 요약해줘', expired));
    expect(kindOf(answer)).toBe('reply');
    expect(replyText(answer)).not.toBe('');
    expect(gets).toEqual([]);
  });

  it('a cross-source mismatch is refused: a Drive list never resolves "N번 메일" and the reverse', async () => {
    const { rows, manager } = store();
    const gets: string[] = [];
    const exports: string[] = [];
    await createDriveTurnHandler({ reader: driveReader(exports), timeZone: 'Asia/Seoul', sessions: manager }).handle(ctxOf(rows, '최근 문서'));
    const mail = createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul', sessions: manager });
    expect(kindOf(await mail.handle(ctxOf(rows, '1번 메일 요약해줘')))).toBe('reply');
    expect(gets).toEqual([]);

    // A mail list kept beside the Drive list does not overwrite it, and each resolves only its own ids.
    await mail.handle(ctxOf(rows, '안 읽은 메일'));
    const drive = createDriveTurnHandler({ reader: driveReader(exports), timeZone: 'Asia/Seoul', sessions: manager });
    expect(kindOf(await drive.handle(ctxOf(rows, '1번 문서 요약해줘')))).toBe('summarize');
    expect(exports).toEqual(['gd-1']);
    expect(kindOf(await mail.handle(ctxOf(rows, '1번 메일 요약해줘')))).toBe('summarize');
    expect(gets).toEqual(['gm-1']);

    // A tampered entry whose source differs from its slot is ignored.
    const byActor = (rows.get('s-1')?.metadata?.[LAST_LISTING_METADATA_KEY] as { byActor: Record<string, Record<string, { source: string }>> }).byActor;
    (byActor['a-1']?.mail as { source: string }).source = 'drive';
    gets.length = 0;
    const restarted = createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul', sessions: manager });
    expect(kindOf(await restarted.handle(ctxOf(rows, '1번 메일 요약해줘')))).toBe('reply');
    expect(gets).toEqual([]);
  });

  it('persists the displayed ids only, per actor; no subject, sender, name or snippet is ever stored', async () => {
    const { rows, manager } = store();
    await createMailTurnHandler({ reader: mailReader([]), timeZone: 'Asia/Seoul', sessions: manager }).handle(ctxOf(rows, '안 읽은 메일'));
    await createDriveTurnHandler({ reader: driveReader([]), timeZone: 'Asia/Seoul', sessions: manager }).handle(ctxOf(rows, '최근 문서', NOW, 'a-2'));
    const stored = rows.get('s-1')?.metadata?.[LAST_LISTING_METADATA_KEY];
    expect(stored).toEqual({
      byActor: {
        // GML-2: the inbound id that asked for the mail listing (opaque, content-free) is kept for reply picks.
        'a-1': { mail: { source: 'mail', ids: ['gm-1', 'gm-2'], at: NOW, requestId: 'm-1' } },
        'a-2': { drive: { source: 'drive', ids: ['gd-1', 'gd-2'], at: NOW } },
      },
    });
    const json = JSON.stringify(rows.get('s-1'));
    for (const text of [SUBJECT, FILE_NAME, SENDER, '김철수', '본문']) expect(json).not.toContain(text);
  });

  it('a persistence failure never fails the turn; the in-memory cache still resolves the number', async () => {
    const { rows } = store();
    const broken = { updateMetadataEntry: async () => { throw new Error('disk'); } };
    const gets: string[] = [];
    const handler = createMailTurnHandler({ reader: mailReader(gets), timeZone: 'Asia/Seoul', sessions: broken });
    expect(kindOf(await handler.handle(ctxOf(rows, '안 읽은 메일')))).toBe('reply');
    expect(kindOf(await handler.handle(ctxOf(rows, '1번 메일 요약해줘')))).toBe('summarize');
    expect(gets).toEqual(['gm-1']);
  });
});

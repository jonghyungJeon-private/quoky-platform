import { describe, expect, it } from 'vitest';
import { renderOutboundForDiscord } from '@quoky/adapter-discord';
import { renderOutboundForTelegram } from '@quoky/adapter-telegram';
import {
  DailyBriefSources,
  OnDemandBrief,
  PLT1_VARIANTS,
  ReminderReplyComposer,
  ReminderTurnHandler,
  type ConversationContext,
  type MailMessageSummary,
  type MailReader,
  type MailSearchQuery,
  type MailSearchResult,
  type Plt1Variant,
  type TurnHandlerContext,
} from '@quoky/core';
import { createBriefSources } from './brief-sources';

// BRF-3 (ADR-0117 amendment): the unread-mail section of the brief, end to end from the composition seam
// (`createBriefSources`) through the on-demand brief and its DM-only handler, rendered on both real platform markups.

const NOW = '2026-10-02T03:00:00.000Z';
const ZONE = 'Asia/Seoul';
const nasty = PLT1_VARIANTS.find((variant) => variant.id === 'nasty') as Plt1Variant;
/** Hostile values from the shared PLT-1 corpus plus a mention, a link, a markup run and a credential. */
const HOSTILE_SUBJECTS = [...nasty.paths, nasty.message, 'pay now https://evil.example/login @everyone', 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'];

function summary(index: number, subject: string, sender: string): MailMessageSummary {
  return { id: `m${index}`, sender: { name: sender, address: '' }, subject, receivedAt: NOW, snippet: 'BODY-SNIPPET', unread: true };
}

class FakeMail implements MailReader {
  readonly source = 'mail';
  readonly readOnly = true as const;
  readonly searches: MailSearchQuery[] = [];
  readonly gets: string[] = [];
  constructor(private readonly result: MailSearchResult | Error) {}
  async search(query: MailSearchQuery): Promise<MailSearchResult> {
    this.searches.push(query);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async getMessage(id: string): Promise<never> {
    this.gets.push(id);
    throw new Error('the brief never reads a body');
  }
}

function briefOver(mail: FakeMail, enabled = true): OnDemandBrief {
  const briefSources = createBriefSources({ briefJiraEnabled: false, briefMailEnabled: enabled, mail, storage: {} });
  return new OnDemandBrief({
    repository: { listActiveByActor: async () => [] },
    workItems: { listByActor: async () => [] },
    composer: new ReminderReplyComposer(),
    timeZone: ZONE,
    ...(briefSources !== undefined ? { briefSources } : {}),
  });
}

function turn(context: ConversationContext): TurnHandlerContext {
  return {
    message: { id: 'm', context, text: '오늘 브리핑', receivedAt: NOW },
    session: { id: 's' },
    actor: { id: 'actor-owner' },
    now: NOW,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  } as unknown as TurnHandlerContext;
}

const SELECTED = { entryId: 'brief.today' as const, args: {}, language: 'ko' as const };
const DISCORD_DM: ConversationContext = { platform: 'discord', channelId: 'dm', userId: 'u', direct: true };
const TELEGRAM_DM: ConversationContext = { platform: 'telegram', channelId: '5550001', userId: '5550001', direct: true };
const CHANNEL: ConversationContext = { platform: 'discord', channelId: 'guild-channel', userId: 'u', spaceId: 'guild-1', direct: false };

function handlerOver(brief: OnDemandBrief): ReminderTurnHandler {
  return new ReminderTurnHandler({
    conversation: { handleTurn: async () => null },
    composer: new ReminderReplyComposer(),
    enabled: true,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    brief,
  });
}

describe('brief mail section: composition and flag (BRF-3)', () => {
  it('flag off: the mail reader is never called and the brief carries no mail section', async () => {
    const mail = new FakeMail({ messages: [summary(1, 'hi', 'Al')], matched: 1, matchedIsLowerBound: false });
    const text = await briefOver(mail, false).compose('actor-owner', NOW);
    expect(mail.searches).toEqual([]);
    expect(JSON.stringify(text)).not.toContain('안 읽은 메일');
  });

  it('flag on: one unread search of 3, no body read, and the count and lines appear', async () => {
    const mail = new FakeMail({ messages: [summary(1, '회의 자료', '김철수'), summary(2, '청구서', 'Bob')], matched: 2, matchedIsLowerBound: false });
    const reply = await handlerOver(briefOver(mail)).handleSelected(SELECTED, turn(DISCORD_DM));
    expect(mail.searches).toEqual([{ unreadOnly: true, limit: 3 }]);
    expect(mail.gets).toEqual([]);
    const text = reply !== null && 'reply' in reply ? reply.reply.text : '';
    expect(text).toContain('안 읽은 메일 2건');
    expect(text).toContain('- 김철수 · 회의 자료');
    expect(text).not.toContain('BODY-SNIPPET');
  });

  it('a mail-reader failure degrades only the mail section', async () => {
    const mail = new FakeMail(new Error('boom'));
    const reply = await handlerOver(briefOver(mail)).handleSelected(SELECTED, turn(DISCORD_DM));
    const text = reply !== null && 'reply' in reply ? reply.reply.text : '';
    expect(text).toContain('안 읽은 메일: 불러오지 못했어요.');
    expect(text).toContain('오늘 남은 알림이 없어요.');
    expect(text).toContain('진행 중인 작업이 없어요.');
  });
});

describe('brief mail section: DM-only (BRF-3)', () => {
  it('outside a DM the brief is refused before any mail read', async () => {
    const mail = new FakeMail({ messages: [summary(1, 'secret subject', 'Al')], matched: 1, matchedIsLowerBound: false });
    const reply = await handlerOver(briefOver(mail)).handleSelected(SELECTED, turn(CHANNEL));
    const text = reply !== null && 'reply' in reply ? reply.reply.text : '';
    expect(mail.searches).toEqual([]);
    expect(text).toContain('DM에서만');
    expect(text).not.toContain('secret subject');
  });
});

describe('brief mail section: hostile subjects and senders on both platforms (BRF-3)', () => {
  const messages = HOSTILE_SUBJECTS.slice(0, 3).map((subject, i) => summary(i + 1, subject, HOSTILE_SUBJECTS[(i + 3) % HOSTILE_SUBJECTS.length] as string));

  async function render(context: ConversationContext): Promise<{ discord: string; telegram: string; plain: string }> {
    const mail = new FakeMail({ messages, matched: 3, matchedIsLowerBound: false });
    const reply = await handlerOver(briefOver(mail)).handleSelected(SELECTED, turn(context));
    if (reply === null || !('reply' in reply)) throw new Error('expected a reply');
    return { discord: renderOutboundForDiscord(reply.reply), telegram: renderOutboundForTelegram(reply.reply), plain: reply.reply.text };
  }

  it('Discord: no live mention, no link, no raw markup run, and no credential', async () => {
    const { discord } = await render(DISCORD_DM);
    expect(discord).not.toContain('@everyone>');
    expect(discord).not.toMatch(/(^|[^\\])@everyone/);
    expect(discord).not.toMatch(/(^|[^\\])<@123>/);
    expect(discord).not.toContain('https://');
    expect(discord).not.toContain('sk-ant');
    expect(discord).not.toMatch(/(^|[^\\])_draft_/);
  });

  it('Telegram: verbatim spans without links or credentials, and the fixed copy is intact', async () => {
    const { telegram } = await render(TELEGRAM_DM);
    expect(telegram).toContain('안 읽은 메일 3건');
    expect(telegram).not.toContain('https://');
    expect(telegram).not.toContain('sk-ant');
  });

  it('every shown line is a sender · subject pair and the plain text carries no id or snippet', async () => {
    const { plain } = await render(DISCORD_DM);
    expect(plain).not.toMatch(/\bm[123]\b/);
    expect(plain).not.toContain('BODY-SNIPPET');
    expect(plain.match(/^- .* · /gm)?.length).toBe(3);
  });
});

describe('brief mail section: no model (BRF-3)', () => {
  it('the source module imports no provider, tool or writer, and the reader port has no write', () => {
    const sources = new DailyBriefSources({ mail: new FakeMail({ messages: [], matched: 0, matchedIsLowerBound: false }) });
    expect(Object.keys((sources as unknown as { deps: Record<string, unknown> }).deps)).toEqual(['mail']);
  });
});

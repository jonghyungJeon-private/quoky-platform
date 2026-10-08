import 'reflect-metadata';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GMAIL_READONLY_SCOPE, GmailMailReader } from '@quoky/connector-gmail';
import {
  CONVERSATION_TURN_HANDLERS,
  ConnectorQueryError,
  MAIL_READER,
  type ConversationTurnHandler,
  type Logger,
  type MailReader,
} from '@quoky/core';
import { loadConfig } from '../config';
import { CALENDAR_TURN_HANDLERS } from './calendar.providers';
import {
  CODE_WORK_TURN_HANDLERS,
  FEEDBACK_TURN_HANDLERS,
  REMINDER_TURN_HANDLERS,
  WORK_CHAT_TURN_HANDLERS,
} from './feature-tokens';
import { MAIL_TURN_HANDLERS, createMailProviders, createMailReader } from './mail.providers';
import { MEMORY_TURN_HANDLERS } from './memory.providers';
import { MODEL_SELECTION_TURN_HANDLERS } from './provider-selection.providers';
import { turnHandlersProvider } from './turn-handlers.providers';

const NOW = '2026-10-08T01:00:00.000Z';
const OWNER = { QUOKY_DISCORD_OWNER_IDS: '111111111111111111' };
const CLIENT = { QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'composition-client', QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'composition-client-placeholder' };

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** The aggregator over empty feature lists plus this feature's providers (`null` = the mail token is not composed). */
async function compose(mailProviders: Provider[] | null) {
  const empty = (token: symbol): Provider => ({ provide: token, useValue: [] });
  @Module({
    providers: [
      empty(CODE_WORK_TURN_HANDLERS),
      empty(WORK_CHAT_TURN_HANDLERS),
      empty(REMINDER_TURN_HANDLERS),
      empty(FEEDBACK_TURN_HANDLERS),
      empty(MEMORY_TURN_HANDLERS),
      empty(CALENDAR_TURN_HANDLERS),
      empty(MODEL_SELECTION_TURN_HANDLERS),
      ...(mailProviders ?? []),
      turnHandlersProvider,
    ],
  })
  class MailCompositionModule {}
  const app = await NestFactory.createApplicationContext(MailCompositionModule, { logger: false });
  return { app, handlers: app.get<readonly ConversationTurnHandler[]>(CONVERSATION_TURN_HANDLERS) };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-gmail-composition-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tokenFile(mode = 0o600): string {
  const path = join(dir, 'gmail.json');
  writeFileSync(path, JSON.stringify({ version: 1, scope: GMAIL_READONLY_SCOPE, refresh_token: 'composition-refresh-placeholder' }), { mode });
  chmodSync(path, mode);
  return path;
}

describe('Gmail configuration (ADR-0118, GML-1): off unless configured', () => {
  it('is undefined without the token file, and without the OAuth client', () => {
    expect(loadConfig({ ...OWNER } as NodeJS.ProcessEnv).gmail).toBeUndefined();
    expect(loadConfig({ ...OWNER, ...CLIENT } as NodeJS.ProcessEnv).gmail).toBeUndefined();
    expect(loadConfig({ ...OWNER, QUOKY_GMAIL_TOKEN_FILE: '/tmp/x.json' } as NodeJS.ProcessEnv).gmail).toBeUndefined();
  });

  it('reuses the calendar OAuth client with its own token file and QUOKY_TIMEZONE', () => {
    const config = loadConfig({ ...OWNER, ...CLIENT, QUOKY_GMAIL_TOKEN_FILE: '/abs/gmail.json', QUOKY_TIMEZONE: 'Asia/Seoul' } as NodeJS.ProcessEnv);
    expect(config.gmail).toEqual({
      google: { clientId: 'composition-client', clientSecret: 'composition-client-placeholder', tokenFile: '/abs/gmail.json' },
      timeZone: 'Asia/Seoul',
    });
    // Gmail does not configure the calendar (which needs its own refresh-token source).
    expect(config.calendar).toBeUndefined();
  });
});

describe('mail feature composition (ADR-0096 D7)', () => {
  it('unconfigured: no MAIL_READER, no mail handler — the handler list is exactly what it is without the feature', async () => {
    const without = await compose(null);
    const unconfigured = await compose(createMailProviders({ gmail: undefined, timeZone: 'Asia/Seoul', logger: silentLogger() }));
    try {
      expect(unconfigured.handlers.map((handler) => [handler.id, handler.stage, handler.order])).toEqual(
        without.handlers.map((handler) => [handler.id, handler.stage, handler.order]),
      );
      expect(unconfigured.handlers.map((handler) => handler.id)).toEqual(['help-intent']);
      expect(unconfigured.app.get(MAIL_TURN_HANDLERS)).toEqual([]);
      expect(() => unconfigured.app.get(MAIL_READER)).toThrow();
    } finally {
      await without.app.close();
      await unconfigured.app.close();
    }
  });

  it('configured: binds the Gmail adapter and registers the order-140 handler with no network call', async () => {
    const gmail = loadConfig({ ...OWNER, ...CLIENT, QUOKY_GMAIL_TOKEN_FILE: tokenFile() } as NodeJS.ProcessEnv).gmail;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { app, handlers } = await compose(createMailProviders({ gmail, timeZone: 'Asia/Seoul', logger: silentLogger() }));
    try {
      expect(app.get(MAIL_READER)).toBeInstanceOf(GmailMailReader);
      expect(handlers.map((handler) => [handler.id, handler.stage, handler.order])).toEqual([
        ['mail', 'pre-classify', 140],
        ['help-intent', 'pre-classify', 400],
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await app.close();
    }
  });

  it('an unsafe or unreadable token file is "no mail": a fixed code is logged, never the path or a value', async () => {
    const logger = silentLogger();
    const unsafe = loadConfig({ ...OWNER, ...CLIENT, QUOKY_GMAIL_TOKEN_FILE: tokenFile(0o644) } as NodeJS.ProcessEnv).gmail;
    expect(createMailReader(unsafe, logger)).toBeUndefined();
    const missing = loadConfig({ ...OWNER, ...CLIENT, QUOKY_GMAIL_TOKEN_FILE: join(dir, 'missing.json') } as NodeJS.ProcessEnv).gmail;
    expect(createMailReader(missing, logger)).toBeUndefined();
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['gmail not registered', { reason: 'GMAIL_TOKEN_FILE_PERMISSIONS' }],
      ['gmail not registered', { reason: 'GMAIL_TOKEN_FILE_UNREADABLE' }],
    ]);
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/placeholder|gmail\.json|quoky-gmail/);
  });

  it('the registered handler answers from the bound reader (DM only)', async () => {
    const reader: MailReader = {
      source: 'mail',
      readOnly: true,
      search: async () => ({ messages: [], matched: 0, matchedIsLowerBound: false }),
      getMessage: async () => {
        throw new Error('not used');
      },
    };
    const { app } = await compose(createMailProviders({ gmail: undefined, timeZone: 'Asia/Seoul', reader, logger: silentLogger() }));
    try {
      const [handler] = app.get<readonly ConversationTurnHandler[]>(MAIL_TURN_HANDLERS);
      const outcome = await (handler as ConversationTurnHandler).handle({
        message: { id: 'm', context: { platform: 'telegram', channelId: 'c', userId: 'u', direct: true }, text: '안 읽은 메일', receivedAt: NOW },
        session: { id: 's' },
        actor: { id: 'a' },
        now: NOW,
        applyAnchor: null,
        resolveActiveWorkspace: async () => null,
      } as unknown as Parameters<ConversationTurnHandler['handle']>[0]);
      expect(outcome && 'reply' in outcome ? outcome.reply.text : '').toBe('안 읽은 메일이 없어요.\n(Gmail 읽기 전용 · Asia/Seoul 기준)');
    } finally {
      await app.close();
    }
  });

  it('review P3-6: the app supplies the Gmail label and the consent step to Core\'s neutral copy', async () => {
    const reader: MailReader = {
      source: 'mail',
      readOnly: true,
      search: async () => {
        throw new ConnectorQueryError('UNAUTHORIZED');
      },
      getMessage: async () => {
        throw new Error('not used');
      },
    };
    const { app } = await compose(createMailProviders({ gmail: undefined, timeZone: 'Asia/Seoul', reader, logger: silentLogger() }));
    try {
      const [handler] = app.get<readonly ConversationTurnHandler[]>(MAIL_TURN_HANDLERS);
      const outcome = await (handler as ConversationTurnHandler).handle({
        message: { id: 'm', context: { platform: 'telegram', channelId: 'c', userId: 'u', direct: true }, text: '안 읽은 메일', receivedAt: NOW },
        session: { id: 's' },
        actor: { id: 'a' },
        now: NOW,
        applyAnchor: null,
        resolveActiveWorkspace: async () => null,
      } as unknown as Parameters<ConversationTurnHandler['handle']>[0]);
      expect(outcome && 'reply' in outcome ? outcome.reply.text : '').toBe(
        'Gmail 연결이 만료됐거나 취소돼서 메일을 확인하지 못했어요. 동의 도구(calendar-auth --gmail)로 다시 연결해 주세요.',
      );
    } finally {
      await app.close();
    }
  });

  it('the feature file wires no provider, router, runtime or writer', () => {
    const source = readFileSync(new URL('./mail.providers.ts', import.meta.url), 'utf8');
    for (const forbidden of ['AI_PROVIDERS', 'PROVIDER_SELECTOR', 'AiProviderManager', 'ConversationRuntime', 'Writer', 'CONNECTOR_WRITE']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

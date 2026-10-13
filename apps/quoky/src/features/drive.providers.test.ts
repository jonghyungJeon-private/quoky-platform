import 'reflect-metadata';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIVE_READONLY_SCOPE, GoogleDriveReader } from '@quoky/connector-gdrive';
import {
  CONVERSATION_TURN_HANDLERS,
  ConnectorQueryError,
  DRIVE_READER,
  type ConversationTurnHandler,
  type DriveReader,
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
import { DRIVE_TURN_HANDLERS, GDRIVE_DRIVE_COPY, createDriveProviders, createDriveReader } from './drive.providers';
import { createMailProviders } from './mail.providers';
import { MEMORY_TURN_HANDLERS } from './memory.providers';
import { MODEL_SELECTION_TURN_HANDLERS } from './provider-selection.providers';
import { turnHandlersProvider } from './turn-handlers.providers';

const NOW = '2026-10-08T01:00:00.000Z';
const OWNER = { QUOKY_DISCORD_OWNER_IDS: '111111111111111111' };
const CLIENT = { QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'composition-client', QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'composition-client-placeholder' };

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** The aggregator over empty feature lists plus this feature's providers (`null` = the Drive token is not composed). */
async function compose(driveProviders: Provider[] | null, mailProviders: Provider[] = []) {
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
      ...mailProviders,
      ...(driveProviders ?? []),
      turnHandlersProvider,
    ],
  })
  class DriveCompositionModule {}
  const app = await NestFactory.createApplicationContext(DriveCompositionModule, { logger: false });
  return { app, handlers: app.get<readonly ConversationTurnHandler[]>(CONVERSATION_TURN_HANDLERS) };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-gdrive-composition-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tokenFile(mode = 0o600): string {
  const path = join(dir, 'drive.json');
  writeFileSync(path, JSON.stringify({ version: 1, scope: DRIVE_READONLY_SCOPE, refresh_token: 'composition-refresh-placeholder' }), { mode });
  chmodSync(path, mode);
  return path;
}

describe('Drive configuration (ADR-0118, DRV-1): off unless configured', () => {
  it('is undefined without the token file, and without the OAuth client', () => {
    expect(loadConfig({ ...OWNER } as NodeJS.ProcessEnv).drive).toBeUndefined();
    expect(loadConfig({ ...OWNER, ...CLIENT } as NodeJS.ProcessEnv).drive).toBeUndefined();
    expect(loadConfig({ ...OWNER, QUOKY_DRIVE_TOKEN_FILE: '/tmp/x.json' } as NodeJS.ProcessEnv).drive).toBeUndefined();
    // Review P2-1: a Gmail-only configuration never configures Drive (no Drive token file is read).
    expect(loadConfig({ ...OWNER, ...CLIENT, QUOKY_GMAIL_TOKEN_FILE: '/abs/gmail.json' } as NodeJS.ProcessEnv).drive).toBeUndefined();
  });

  it('reuses the calendar OAuth client with its own token file and QUOKY_TIMEZONE; Gmail and Drive are independent', () => {
    const config = loadConfig({ ...OWNER, ...CLIENT, QUOKY_DRIVE_TOKEN_FILE: '/abs/drive.json', QUOKY_TIMEZONE: 'Asia/Seoul' } as NodeJS.ProcessEnv);
    expect(config.drive).toEqual({
      google: { clientId: 'composition-client', clientSecret: 'composition-client-placeholder', tokenFile: '/abs/drive.json' },
      timeZone: 'Asia/Seoul',
    });
    expect(config.gmail).toBeUndefined();
    expect(config.calendar).toBeUndefined();
    const both = loadConfig({ ...OWNER, ...CLIENT, QUOKY_DRIVE_TOKEN_FILE: '/abs/drive.json', QUOKY_GMAIL_TOKEN_FILE: '/abs/gmail.json' } as NodeJS.ProcessEnv);
    expect([both.drive?.google.tokenFile, both.gmail?.google.tokenFile]).toEqual(['/abs/drive.json', '/abs/gmail.json']);
  });
});

const emptyReader: DriveReader = {
  source: 'drive',
  readOnly: true,
  searchByName: async () => ({ files: [], matched: 0, matchedIsLowerBound: false }),
  recentFiles: async () => ({ files: [], matched: 0, matchedIsLowerBound: false }),
  exportText: async () => {
    throw new Error('not used');
  },
};

async function ask(handler: ConversationTurnHandler, text: string): Promise<string> {
  const outcome = await handler.handle({
    message: { id: 'm', context: { platform: 'telegram', channelId: 'c', userId: 'u', direct: true }, text, receivedAt: NOW },
    session: { id: 's' },
    actor: { id: 'a' },
    now: NOW,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  } as unknown as Parameters<ConversationTurnHandler['handle']>[0]);
  return outcome && 'reply' in outcome ? outcome.reply.text : '';
}

describe('Drive feature composition (ADR-0096 D7)', () => {
  it('unconfigured: no DRIVE_READER, no Drive handler — the handler list is exactly what it is without the feature', async () => {
    const without = await compose(null);
    const unconfigured = await compose(createDriveProviders({ drive: undefined, timeZone: 'Asia/Seoul', logger: silentLogger() }));
    try {
      expect(unconfigured.handlers.map((handler) => [handler.id, handler.stage, handler.order])).toEqual(
        without.handlers.map((handler) => [handler.id, handler.stage, handler.order]),
      );
      expect(unconfigured.handlers.map((handler) => handler.id)).toEqual(['help-intent']);
      expect(unconfigured.app.get(DRIVE_TURN_HANDLERS)).toEqual([]);
      expect(() => unconfigured.app.get(DRIVE_READER)).toThrow();
    } finally {
      await without.app.close();
      await unconfigured.app.close();
    }
  });

  it('configured: binds the Drive adapter and registers the order-145 handler with no network call', async () => {
    const drive = loadConfig({ ...OWNER, ...CLIENT, QUOKY_DRIVE_TOKEN_FILE: tokenFile() } as NodeJS.ProcessEnv).drive;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { app, handlers } = await compose(createDriveProviders({ drive, timeZone: 'Asia/Seoul', logger: silentLogger() }));
    try {
      expect(app.get(DRIVE_READER)).toBeInstanceOf(GoogleDriveReader);
      expect(handlers.map((handler) => [handler.id, handler.stage, handler.order])).toEqual([
        ['drive', 'pre-classify', 145],
        ['help-intent', 'pre-classify', 400],
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await app.close();
    }
  });

  it('with Gmail too: mail (140) then Drive (145), and each answers only its own phrasing', async () => {
    const mailReader: MailReader = {
      source: 'mail',
      readOnly: true,
      search: async () => ({ messages: [], matched: 0, matchedIsLowerBound: false }),
      getMessage: async () => {
        throw new Error('not used');
      },
    };
    const { app, handlers } = await compose(
      createDriveProviders({ drive: undefined, timeZone: 'Asia/Seoul', reader: emptyReader, logger: silentLogger() }),
      createMailProviders({ gmail: undefined, timeZone: 'Asia/Seoul', reader: mailReader, logger: silentLogger() }),
    );
    try {
      expect(handlers.map((handler) => [handler.id, handler.order])).toEqual([
        ['mail', 140],
        ['drive', 145],
        ['help-intent', 400],
      ]);
      const drive = handlers.find((handler) => handler.id === 'drive') as ConversationTurnHandler;
      for (const text of ['안 읽은 메일', '1번 메일 요약해줘', '오늘 일정']) expect(await drive.handle({
        message: { id: 'm', context: { platform: 'telegram', channelId: 'c', userId: 'u', direct: true }, text, receivedAt: NOW },
        session: { id: 's' },
        actor: { id: 'a' },
        now: NOW,
        applyAnchor: null,
        resolveActiveWorkspace: async () => null,
      } as unknown as Parameters<ConversationTurnHandler['handle']>[0]), text).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('an unsafe, unreadable or Gmail token file is "no Drive": a fixed code is logged, never the path or a value', () => {
    const logger = silentLogger();
    const unsafe = loadConfig({ ...OWNER, ...CLIENT, QUOKY_DRIVE_TOKEN_FILE: tokenFile(0o644) } as NodeJS.ProcessEnv).drive;
    expect(createDriveReader(unsafe, logger)).toBeUndefined();
    const missing = loadConfig({ ...OWNER, ...CLIENT, QUOKY_DRIVE_TOKEN_FILE: join(dir, 'missing.json') } as NodeJS.ProcessEnv).drive;
    expect(createDriveReader(missing, logger)).toBeUndefined();
    const gmailFile = join(dir, 'gmail.json');
    writeFileSync(gmailFile, JSON.stringify({ version: 1, scope: 'https://www.googleapis.com/auth/gmail.readonly', refresh_token: 'composition-refresh-placeholder' }), { mode: 0o600 });
    chmodSync(gmailFile, 0o600);
    const wrongGrant = loadConfig({ ...OWNER, ...CLIENT, QUOKY_DRIVE_TOKEN_FILE: gmailFile } as NodeJS.ProcessEnv).drive;
    expect(createDriveReader(wrongGrant, logger)).toBeUndefined();
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['drive not registered', { reason: 'GDRIVE_TOKEN_FILE_PERMISSIONS' }],
      ['drive not registered', { reason: 'GDRIVE_TOKEN_FILE_UNREADABLE' }],
      ['drive not registered', { reason: 'GDRIVE_TOKEN_FILE_INVALID' }],
    ]);
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/placeholder|drive\.json|gmail\.json|quoky-gdrive/);
  });

  it('the registered handler answers from the bound reader (DM only), with the app-supplied label', async () => {
    const { app } = await compose(createDriveProviders({ drive: undefined, timeZone: 'Asia/Seoul', reader: emptyReader, logger: silentLogger() }));
    try {
      const [handler] = app.get<readonly ConversationTurnHandler[]>(DRIVE_TURN_HANDLERS);
      expect(await ask(handler as ConversationTurnHandler, '최근 문서')).toBe('최근 수정한 파일이 없어요.\n(Google Drive 읽기 전용 · Asia/Seoul 기준)');
    } finally {
      await app.close();
    }
  });

  it('the app supplies the Google Drive label and the consent step to Core\'s neutral copy', async () => {
    const failing: DriveReader = {
      ...emptyReader,
      recentFiles: async () => {
        throw new ConnectorQueryError('UNAUTHORIZED');
      },
    };
    const { app } = await compose(createDriveProviders({ drive: undefined, timeZone: 'Asia/Seoul', reader: failing, logger: silentLogger() }));
    try {
      const [handler] = app.get<readonly ConversationTurnHandler[]>(DRIVE_TURN_HANDLERS);
      expect(await ask(handler as ConversationTurnHandler, '최근 문서')).toBe(
        'Google Drive 연결이 만료됐거나 취소돼서 파일을 확인하지 못했어요. 동의 도구(calendar-auth --drive)로 다시 연결해 주세요.',
      );
    } finally {
      await app.close();
    }
  });

  it('the feature file wires no provider, router, runtime or writer', () => {
    const source = readFileSync(new URL('./drive.providers.ts', import.meta.url), 'utf8');
    for (const forbidden of ['AI_PROVIDERS', 'PROVIDER_SELECTOR', 'AiProviderManager', 'ConversationRuntime', 'Writer', 'CONNECTOR_WRITE']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('DRV-2b composition copy', () => {
  it('names the service the owner enables to read every sheet (Core holds no vendor name)', () => {
    expect(GDRIVE_DRIVE_COPY.allSheetsHint).toEqual({
      ko: '모든 시트를 읽으려면 Google Sheets API가 필요해요',
      en: 'reading every sheet needs the Google Sheets API enabled',
    });
    expect(Object.isFrozen(GDRIVE_DRIVE_COPY.allSheetsHint)).toBe(true);
  });
});

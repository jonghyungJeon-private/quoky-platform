import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Module, type Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarReader } from '@quoky/connector-calendar-google';
import {
  CALENDAR_READER,
  CONVERSATION_TURN_HANDLERS,
  IntentClassifier,
  POLICY_SENSITIVE_CHAT_KIND,
  type CalendarReader,
  type ConversationTurnHandler,
  type Logger,
} from '@quoky/core';
import { loadConfig } from '../config';
import { CALENDAR_TURN_HANDLERS, createCalendarProviders } from './calendar.providers';
import {
  CODE_WORK_TURN_HANDLERS,
  FEEDBACK_TURN_HANDLERS,
  REMINDER_TURN_HANDLERS,
  WORK_CHAT_TURN_HANDLERS,
} from './feature-tokens';
import { MEMORY_TURN_HANDLERS } from './memory.providers';
import { MODEL_SELECTION_TURN_HANDLERS } from './provider-selection.providers';
import { turnHandlersProvider } from './turn-handlers.providers';

const NOW = '2026-10-06T01:00:00.000Z';

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** The aggregator over empty feature lists plus this feature's providers (no other feature is composed). */
async function compose(calendarProviders: Provider[]) {
  const empty = (token: symbol): Provider => ({ provide: token, useValue: [] });
  @Module({
    providers: [
      empty(CODE_WORK_TURN_HANDLERS),
      empty(WORK_CHAT_TURN_HANDLERS),
      empty(REMINDER_TURN_HANDLERS),
      empty(FEEDBACK_TURN_HANDLERS),
      empty(MEMORY_TURN_HANDLERS),
      empty(MODEL_SELECTION_TURN_HANDLERS),
      ...calendarProviders,
      turnHandlersProvider,
    ],
  })
  class CalendarCompositionModule {}
  const app = await NestFactory.createApplicationContext(CalendarCompositionModule, { logger: false });
  return {
    app,
    handlers: app.get<readonly ConversationTurnHandler[]>(CONVERSATION_TURN_HANDLERS),
    calendarHandlers: app.get<readonly ConversationTurnHandler[]>(CALENDAR_TURN_HANDLERS),
  };
}

function ctx(text: string) {
  return {
    message: { id: 'm', context: { platform: 'discord', channelId: 'c', userId: 'u' }, text, receivedAt: NOW },
    session: {},
    actor: {},
    now: NOW,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  } as unknown as Parameters<ConversationTurnHandler['handle']>[0];
}

describe('calendar feature composition (ADR-0110 D5, CAL-2)', () => {
  it('with no calendar configured: no CALENDAR_READER binding, no calendar handler, QUAL-7 routing unchanged', async () => {
    const { app, handlers, calendarHandlers } = await compose(
      createCalendarProviders({ calendar: undefined, timeZone: 'Asia/Seoul', logger: silentLogger() }),
    );
    try {
      expect(calendarHandlers).toEqual([]);
      expect(handlers.map((handler) => handler.id)).toEqual(['help-intent']);
      expect(() => app.get(CALENDAR_READER)).toThrow();
      // The schedule questions still classify as POLICY_SENSITIVE_CHAT (the "I cannot see your schedule" path).
      const classifier = new IntentClassifier();
      for (const text of ['내일 일정 뭐야?', '다음 회의 언제야?', "What's my next meeting?", '나 내일 바빠?']) {
        const intent = await classifier.classify({ id: 'm', context: { platform: 'discord', channelId: 'c', userId: 'u' }, text, receivedAt: NOW });
        expect(intent.raw?.kind, text).toBe(POLICY_SENSITIVE_CHAT_KIND);
      }
    } finally {
      await app.close();
    }
  });

  it('with a configured calendar: binds the CAL-1 Google adapter and registers the order-150 handler (no network)', async () => {
    const calendar = loadConfig({
      QUOKY_DISCORD_OWNER_IDS: '111111111111111111',
      QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'composition-client',
      QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'composition-client-placeholder',
      QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: 'composition-refresh-placeholder',
    } as NodeJS.ProcessEnv).calendar;
    expect(calendar).toBeDefined();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { app, handlers, calendarHandlers } = await compose(
      createCalendarProviders({ calendar, timeZone: 'Asia/Seoul', logger: silentLogger() }),
    );
    try {
      expect(app.get(CALENDAR_READER)).toBeInstanceOf(GoogleCalendarReader);
      expect(calendarHandlers.map((handler) => [handler.id, handler.stage, handler.order])).toEqual([['calendar', 'pre-classify', 150]]);
      expect(handlers.map((handler) => handler.id)).toEqual(['calendar', 'help-intent']);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await app.close();
    }
  });

  it('a calendar configuration the adapter rejects is "no calendar" (fixed reason logged, nothing registered)', async () => {
    const logger = silentLogger();
    const providers = createCalendarProviders({
      calendar: {
        google: { clientId: 'id', clientSecret: 'secret-placeholder', refreshToken: 'refresh-placeholder', calendarIds: [] },
        timeZone: 'Not/AZone',
      },
      timeZone: 'Asia/Seoul',
      logger,
    });
    const { app, calendarHandlers } = await compose(providers);
    try {
      expect(calendarHandlers).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith('calendar not registered', { reason: 'CALENDAR_CONFIGURATION_REJECTED' });
      expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('placeholder');
    } finally {
      await app.close();
    }
  });

  it('the registered handler answers from the bound reader in QUOKY_TIMEZONE', async () => {
    const reads: unknown[] = [];
    const reader: CalendarReader = {
      source: 'calendar',
      readOnly: true,
      listEvents: async (query) => {
        reads.push(query);
        return [];
      },
    };
    const { app, calendarHandlers } = await compose(
      createCalendarProviders({ calendar: undefined, timeZone: 'Asia/Seoul', reader, logger: silentLogger() }),
    );
    try {
      const outcome = await (calendarHandlers[0] as ConversationTurnHandler).handle(ctx('오늘 일정'));
      expect(outcome && 'reply' in outcome ? outcome.reply.text : '').toContain('오늘 · 10월 6일(화): 캘린더에 일정이 없어요.');
      expect(reads).toEqual([{ from: '2026-10-05T15:00:00.000Z', to: '2026-10-06T15:00:00.000Z', limit: 50 }]);
    } finally {
      await app.close();
    }
  });

  it('the feature file wires no provider, router or runtime (ADR-0110 D4: calendar text reaches no model)', () => {
    const source = readFileSync(new URL('./calendar.providers.ts', import.meta.url), 'utf8');
    for (const forbidden of ['AI_PROVIDERS', 'PROVIDER_SELECTOR', 'AiProviderManager', 'ConversationRuntime', 'summarize']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

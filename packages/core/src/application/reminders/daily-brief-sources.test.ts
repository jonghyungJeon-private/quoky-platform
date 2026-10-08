import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../../domain';
import type { CalendarEvent, CalendarEventQuery, CalendarReader } from '../../ports/calendar-reader.port';
import type { ConnectorItem, ConnectorProvider, ConnectorQuery, ConnectorResult } from '../../ports/connector-provider.port';
import { ConnectorQueryError } from '../../ports/connector-query';
import type { LogFields, Logger } from '../../ports/logger.port';
import { DailyBriefSources } from './daily-brief-sources';

const ZONE = 'Asia/Seoul';
// 2026-10-02 08:00 KST (Friday).
const NOW = '2026-10-01T23:00:00.000Z';
const REQUEST = { actorId: 'actor-1', now: NOW, timeZone: ZONE };

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
  warn(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
  error(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
}

const EVENT: CalendarEvent = {
  id: 'e1',
  title: '팀 스탠드업',
  start: '2026-10-02T00:30:00.000Z',
  end: '2026-10-02T01:00:00.000Z',
  allDay: false,
  status: 'confirmed',
  calendarName: 'primary',
};

class FakeCalendar implements CalendarReader {
  readonly source = 'calendar';
  readonly readOnly = true as const;
  readonly queries: CalendarEventQuery[] = [];
  constructor(private readonly behaviour: readonly CalendarEvent[] | Error | 'hang') {}
  listEvents(query: CalendarEventQuery): Promise<readonly CalendarEvent[]> {
    this.queries.push(query);
    if (this.behaviour === 'hang') return new Promise(() => undefined);
    if (this.behaviour instanceof Error) return Promise.reject(this.behaviour);
    return Promise.resolve(this.behaviour);
  }
}

class FakeConnector implements ConnectorProvider {
  readonly source = 'tracker';
  readonly readOnly = true;
  readonly queries: ConnectorQuery[] = [];
  available = true;
  constructor(private readonly behaviour: ((query: ConnectorQuery) => ConnectorItem[]) | Error | 'hang' = () => []) {}
  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  query(query: ConnectorQuery): Promise<ConnectorResult> {
    this.queries.push(query);
    if (this.behaviour === 'hang') return new Promise(() => undefined);
    if (this.behaviour instanceof Error) return Promise.reject(this.behaviour);
    return Promise.resolve({ source: this.source, items: this.behaviour(query) });
  }
}

function owner(identities: Actor['identities']): { get(id: string): Promise<Actor | null> } {
  return {
    async get(id) {
      return id === 'actor-1' ? { id, displayName: 'Owner', identities, createdAt: NOW } : null;
    },
  };
}

describe('DailyBriefSources — calendar (ADR-0117 D1)', () => {
  it("reads today's window in the zone once, at the port's maximum limit", async () => {
    const calendar = new FakeCalendar([EVENT]);
    const readout = await new DailyBriefSources({ calendar }).read(REQUEST);
    expect(calendar.queries).toEqual([{ from: '2026-10-01T15:00:00.000Z', to: '2026-10-02T15:00:00.000Z', limit: 50 }]);
    expect(readout).toEqual({ calendar: { events: [EVENT], limit: 50 } });
  });

  it('with no reader configured, has no calendar key (the section is omitted)', async () => {
    expect(await new DailyBriefSources({}).read(REQUEST)).toEqual({});
  });

  it('a failed read is null, logged with the failure class only', async () => {
    const logger = new RecordingLogger();
    const readout = await new DailyBriefSources({
      calendar: new FakeCalendar(new ConnectorQueryError('UNAUTHORIZED')),
      logger,
    }).read(REQUEST);
    expect(readout).toEqual({ calendar: null });
    expect(logger.lines).toEqual(['reminder.brief.calendar_failed {"reason":"UNAUTHORIZED"}']);
  });

  it('a slow calendar is bounded: the read times out to null and the brief is not held', async () => {
    const logger = new RecordingLogger();
    const started = Date.now();
    const readout = await new DailyBriefSources({ calendar: new FakeCalendar('hang'), calendarTimeoutMs: 20, logger }).read(REQUEST);
    expect(readout).toEqual({ calendar: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logger.lines).toEqual(['reminder.brief.calendar_failed {"reason":"TIMEOUT"}']);
  });

  it('a malformed result is null, never an empty day', async () => {
    const calendar = new FakeCalendar(undefined as unknown as CalendarEvent[]);
    expect(await new DailyBriefSources({ calendar }).read(REQUEST)).toEqual({ calendar: null });
  });

  it('logs never carry an event title', async () => {
    const logger = new RecordingLogger();
    await new DailyBriefSources({ calendar: new FakeCalendar([EVENT]), logger }).read(REQUEST);
    expect(logger.lines.join('\n')).not.toContain('스탠드업');
  });
});

describe('DailyBriefSources — assigned work (ADR-0117 D2)', () => {
  it("queries the personal-work named query twice (all, due-this-week) for the owner's identity on that connector", async () => {
    const connector = new FakeConnector((query) => [
      { id: `X-${(query.params as { filter: string }).filter}`, title: 't', dueDate: '2026-10-02' },
    ]);
    const readout = await new DailyBriefSources({
      work: { connector, actors: owner([{ platform: 'chat', externalId: 'chat-id' }, { platform: 'tracker', externalId: ' owner-account ' }]) },
    }).read(REQUEST);
    expect(connector.queries).toEqual([
      { query: 'personal-work', params: { actorExternalId: 'owner-account', filter: 'all', limit: 20 } },
      { query: 'personal-work', params: { actorExternalId: 'owner-account', filter: 'due-this-week', limit: 20 } },
    ]);
    expect(readout.assignedWork?.map((item) => item.id)).toEqual(['X-all', 'X-due-this-week']);
    expect(readout).not.toHaveProperty('calendar');
  });

  it('without a work source (the flag off), has no assignedWork key and queries nothing', async () => {
    const readout = await new DailyBriefSources({ calendar: new FakeCalendar([]) }).read(REQUEST);
    expect(readout).toEqual({ calendar: { events: [], limit: 50 } });
  });

  it.each([
    ['no identity on that connector', () => ({ connector: new FakeConnector(), actors: owner([{ platform: 'chat', externalId: 'x' }]) }), 'IDENTITY_MISSING'],
    ['no actor', () => ({ connector: new FakeConnector(), actors: { get: async () => null } }), 'IDENTITY_MISSING'],
    [
      'an unavailable connector',
      () => {
        const connector = new FakeConnector();
        connector.available = false;
        return { connector, actors: owner([{ platform: 'tracker', externalId: 'a' }]) };
      },
      'UNAVAILABLE',
    ],
    ['a rejected query', () => ({ connector: new FakeConnector(new ConnectorQueryError('RATE_LIMITED')), actors: owner([{ platform: 'tracker', externalId: 'a' }]) }), 'RATE_LIMITED'],
    ['an unexpected error', () => ({ connector: new FakeConnector(new Error('boom with detail')), actors: owner([{ platform: 'tracker', externalId: 'a' }]) }), 'UNAVAILABLE'],
  ])('%s is null (could not read), logged by class', async (_name, work, reason) => {
    const logger = new RecordingLogger();
    const readout = await new DailyBriefSources({ work: work(), logger }).read(REQUEST);
    expect(readout).toEqual({ assignedWork: null });
    expect(logger.lines).toEqual([`reminder.brief.work_failed {"reason":"${reason}"}`]);
  });

  it('a slow connector is bounded by its own deadline; both sources read concurrently', async () => {
    const started = Date.now();
    const readout = await new DailyBriefSources({
      calendar: new FakeCalendar('hang'),
      calendarTimeoutMs: 30,
      work: { connector: new FakeConnector('hang'), actors: owner([{ platform: 'tracker', externalId: 'a' }]) },
      workTimeoutMs: 30,
    }).read(REQUEST);
    expect(readout).toEqual({ calendar: null, assignedWork: null });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('DailyBriefSources boundary (ADR-0117 D3)', () => {
  const source = readFileSync(new URL('./daily-brief-sources.ts', import.meta.url), 'utf8');
  const imports = source.split('\n').filter((line) => /^\s*(import|\} from)/.test(line)).join('\n');

  it('imports only read ports: no provider, tool, write, task, work-item write or runtime module', () => {
    expect(imports).not.toMatch(/ai-provider|tool-provider|tool-manager|task-manager|work-manager|conversation-runtime|connector-write|calendar-writer|workspace|git-provider|command-runner/i);
  });

  it('accepts only the documented dependency keys', () => {
    const sources = new DailyBriefSources({ calendar: new FakeCalendar([]) });
    expect(Object.keys((sources as unknown as { deps: Record<string, unknown> }).deps)).toEqual(['calendar']);
  });
});

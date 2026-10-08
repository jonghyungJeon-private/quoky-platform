import { describe, expect, it } from 'vitest';
import type { CalendarReader, ConnectorProvider } from '@quoky/core';
import { BRIEF_WORK_CONNECTOR_SOURCE, createBriefSources } from './brief-sources';

const calendar: CalendarReader = { source: 'calendar', readOnly: true, listEvents: async () => [] };
const connector = (source: string, readOnly = true): ConnectorProvider => ({
  source,
  readOnly,
  isAvailable: async () => true,
  query: async () => ({ source, items: [] }),
});
const depsOf = (sources: unknown) => (sources as { deps: Record<string, unknown> }).deps;

describe('createBriefSources (ADR-0117 D1/D2, BRF-1)', () => {
  it('no calendar and the Jira flag off: no sources (the local-only brief)', () => {
    expect(createBriefSources({ briefJiraEnabled: false, connectors: [connector('jira')], storage: {} })).toBeUndefined();
    expect(createBriefSources({ briefJiraEnabled: false, calendar: null, connectors: null, storage: {} })).toBeUndefined();
  });

  it('a configured calendar alone: the calendar source, no work source even with Jira registered', () => {
    const sources = createBriefSources({ briefJiraEnabled: false, calendar, connectors: [connector('jira')], storage: {} });
    expect(Object.keys(depsOf(sources))).toEqual(['calendar']);
    expect(depsOf(sources)['calendar']).toBe(calendar);
  });

  it('the Jira flag on picks only the read-only Jira connector', () => {
    const jira = connector(BRIEF_WORK_CONNECTOR_SOURCE);
    const sources = createBriefSources({ briefJiraEnabled: true, connectors: [connector('github'), jira], storage: {} });
    expect(Object.keys(depsOf(sources))).toEqual(['work']);
    expect((depsOf(sources)['work'] as { connector: ConnectorProvider }).connector).toBe(jira);
    expect(createBriefSources({ briefJiraEnabled: true, connectors: [connector('github')], storage: {} })).toBeUndefined();
    expect(createBriefSources({ briefJiraEnabled: true, connectors: [connector('jira', false)], storage: {} })).toBeUndefined();
  });

  it('reads the actor storage at call time (after init), and rejects before it', async () => {
    const storage: { actors?: { get(id: string): Promise<null> } } = {};
    const sources = createBriefSources({ briefJiraEnabled: true, connectors: [connector('jira')], storage });
    const actors = (depsOf(sources)['work'] as { actors: { get(id: string): Promise<unknown> } }).actors;
    await expect(actors.get('a')).rejects.toThrow('actor storage is not initialized');
    storage.actors = { get: async () => null };
    await expect(actors.get('a')).resolves.toBeNull();
  });
});

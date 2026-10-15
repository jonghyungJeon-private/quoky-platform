import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_QUERY_DEFAULT_LIMIT,
  CONNECTOR_QUERY_DEFAULT_TIMEOUT_MS,
  CONNECTOR_QUERY_ERROR_REASONS,
  CONNECTOR_QUERY_MAX_LIMIT,
  CONNECTOR_SEARCH_TEXT_MAX_LENGTH,
  ConnectorQueryError,
  ConnectorQueryName,
  connectorQueryErrorReasonForStatus,
  isConnectorQueryError,
  parsePersonalWorkParams,
  parseSearchParams,
  resolveConnectorQueryLimit,
  resolveConnectorQueryTimeoutMs,
  toConnectorDueDate,
  toConnectorTimestamp,
} from './connector-query';
import * as ports from './index';

describe('connector query vocabulary', () => {
  it('names exactly the read-only queries (the two of ADR-0100 D7 and the three of ADR-0120 A8) and bounds results to 20', () => {
    expect(ConnectorQueryName).toEqual({
      PERSONAL_WORK: 'personal-work',
      SEARCH: 'search',
      CONTAINERS: 'containers',
      RELEASES: 'releases',
      RELEASE_ITEMS: 'release-items',
    });
    expect(CONNECTOR_QUERY_DEFAULT_LIMIT).toBe(20);
    expect(CONNECTOR_QUERY_MAX_LIMIT).toBe(20);
    expect(CONNECTOR_SEARCH_TEXT_MAX_LENGTH).toBe(100);
    expect(CONNECTOR_QUERY_DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  it('is exported from the ports barrel', () => {
    expect(ports.ConnectorQueryError).toBe(ConnectorQueryError);
    expect(ports.ConnectorQueryName).toBe(ConnectorQueryName);
  });

  it('pins the neutral error taxonomy', () => {
    expect([...CONNECTOR_QUERY_ERROR_REASONS]).toEqual([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INSUFFICIENT_SCOPE',
      'NOT_FOUND',
      'RATE_LIMITED',
      'UNSUPPORTED_QUERY',
      'UNAVAILABLE',
      'INVALID_RESPONSE',
    ]);
  });
});

describe('ConnectorQueryError', () => {
  it('carries a reason and a value-free default message', () => {
    const error = new ConnectorQueryError('INSUFFICIENT_SCOPE');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ConnectorQueryError');
    expect(error.reason).toBe('INSUFFICIENT_SCOPE');
    expect(error.message).toBe('connector query failed (insufficient_scope)');
    expect(isConnectorQueryError(error)).toBe(true);
    expect(isConnectorQueryError(new Error('x'))).toBe(false);
  });

  it('maps HTTP statuses to reasons', () => {
    expect(connectorQueryErrorReasonForStatus(401)).toBe('UNAUTHORIZED');
    expect(connectorQueryErrorReasonForStatus(403)).toBe('FORBIDDEN');
    expect(connectorQueryErrorReasonForStatus(404)).toBe('NOT_FOUND');
    expect(connectorQueryErrorReasonForStatus(429)).toBe('RATE_LIMITED');
    expect(connectorQueryErrorReasonForStatus(500)).toBe('UNAVAILABLE');
    expect(connectorQueryErrorReasonForStatus(418)).toBe('UNAVAILABLE');
  });
});

describe('limit and timeout resolution', () => {
  it('defaults, clamps and rejects', () => {
    expect(resolveConnectorQueryLimit(undefined)).toBe(20);
    expect(resolveConnectorQueryLimit(5)).toBe(5);
    expect(resolveConnectorQueryLimit(500)).toBe(20);
    for (const bad of [0, -1, 1.5, '5', null, Number.NaN]) {
      expect(() => resolveConnectorQueryLimit(bad)).toThrow(ConnectorQueryError);
    }
  });

  it('defaults the timeout and rejects invalid configuration', () => {
    expect(resolveConnectorQueryTimeoutMs(undefined)).toBe(10_000);
    expect(resolveConnectorQueryTimeoutMs(250)).toBe(250);
    for (const bad of [0, -1, 1.5, 120_001, '10', null]) {
      expect(() => resolveConnectorQueryTimeoutMs(bad, 'x connector')).toThrow(/x connector: timeoutMs/);
    }
  });
});

describe('parsePersonalWorkParams', () => {
  it('applies defaults and trims the identity', () => {
    // ADR-0120 D13: role and status default to the ADR-0100 query (assignee, open); no window unless given.
    expect(parsePersonalWorkParams({ actorExternalId: ' octocat ' })).toEqual({
      actorExternalId: 'octocat',
      filter: 'all',
      limit: 20,
      role: 'assignee',
      status: 'open',
    });
    expect(parsePersonalWorkParams({ actorExternalId: 'a', filter: 'review-requested', limit: 3 })).toEqual({
      actorExternalId: 'a',
      filter: 'review-requested',
      limit: 3,
      role: 'assignee',
      status: 'open',
    });
  });

  it('accepts the ADR-0120 D13 window, role and status and rejects anything outside the closed sets', () => {
    expect(
      parsePersonalWorkParams({
        actorExternalId: 'a',
        window: { field: 'created', from: '2026-10-12', to: '2026-10-13' },
        role: 'either',
        status: 'all',
      }),
    ).toEqual({
      actorExternalId: 'a',
      filter: 'all',
      limit: 20,
      window: { field: 'created', from: '2026-10-12', to: '2026-10-13' },
      role: 'either',
      status: 'all',
    });
    expect(
      parsePersonalWorkParams({
        actorExternalId: 'a',
        window: { field: 'created', from: '2026-10-12', to: '2026-10-13', fromInstant: '2026-10-11T15:00:00.000Z', toInstant: '2026-10-12T15:00:00.000Z' },
      }).window,
    ).toEqual({ field: 'created', from: '2026-10-12', to: '2026-10-13', fromInstant: '2026-10-11T15:00:00.000Z', toInstant: '2026-10-12T15:00:00.000Z' });
    for (const instants of [
      { fromInstant: '2026-10-11T15:00:00.000Z' },
      { fromInstant: '2026-10-12T15:00:00.000Z', toInstant: '2026-10-11T15:00:00.000Z' },
      { fromInstant: '2026-08-01T00:00:00.000Z', toInstant: '2026-10-12T15:00:00.000Z' },
      { fromInstant: 'yesterday', toInstant: '2026-10-12T15:00:00.000Z' },
      { fromInstant: '2026-10-11T15:00:00+09:00', toInstant: '2026-10-12T15:00:00.000Z' },
    ]) {
      expect(() => parsePersonalWorkParams({ actorExternalId: 'a', window: { field: 'created', from: '2026-10-12', to: '2026-10-13', ...instants } })).toThrow(/window/);
    }
    for (const bad of [
      { role: 'watcher' },
      { status: 'closed' },
      { window: { field: 'resolved', from: '2026-10-12', to: '2026-10-13' } },
      { window: { field: 'created', from: '2026-10-13', to: '2026-10-12' } },
      { window: { field: 'created', from: '2026-10-12', to: '2026-10-12' } },
      { window: { field: 'created', from: '2026-02-30', to: '2026-03-02' } },
      { window: { field: 'created', from: '2026-09-01', to: '2026-10-13' } },
      { window: { field: 'created', from: '2026-10-12) OR project = X', to: '2026-10-13' } },
      { window: 'today' },
    ]) {
      expect(() => parsePersonalWorkParams({ actorExternalId: 'a', ...bad })).toThrow(/personal-work/);
    }
  });

  it.each([
    [undefined],
    [{}],
    [{ actorExternalId: '  ' }],
    [{ actorExternalId: 5 }],
    [{ actorExternalId: 'a\nb' }],
    [{ actorExternalId: 'x'.repeat(201) }],
    [{ actorExternalId: 'a', filter: 'everything' }],
    [{ actorExternalId: 'a', filter: 3 }],
    [{ actorExternalId: 'a', limit: 0 }],
  ])('rejects %j as UNSUPPORTED_QUERY', (params) => {
    expect(() => parsePersonalWorkParams(params as never, 'x connector')).toThrow(ConnectorQueryError);
    try {
      parsePersonalWorkParams(params as never, 'x connector');
    } catch (error) {
      expect((error as ConnectorQueryError).reason).toBe('UNSUPPORTED_QUERY');
      expect((error as ConnectorQueryError).message).toMatch(/^x connector: /);
    }
  });

  it('keeps error messages value-free', () => {
    try {
      parsePersonalWorkParams({ actorExternalId: 'secret\nvalue' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });
});

describe('parseSearchParams', () => {
  it('normalizes whitespace and control characters', () => {
    expect(parseSearchParams({ text: '  deploy \t\n  guide\u0000 ' })).toEqual({ text: 'deploy guide', limit: 20 });
    expect(parseSearchParams({ text: 'x', limit: 4 })).toEqual({ text: 'x', limit: 4 });
  });

  it('accepts exactly 100 characters and rejects 101, empty and non-string text', () => {
    expect(parseSearchParams({ text: 'a'.repeat(100) }).text).toHaveLength(100);
    for (const text of ['a'.repeat(101), '', '   \n', undefined, 7]) {
      expect(() => parseSearchParams({ text })).toThrow(ConnectorQueryError);
    }
    expect(() => parseSearchParams(undefined)).toThrow(ConnectorQueryError);
  });
});

describe('item field normalizers', () => {
  it('normalizes timestamps to ISO and drops unparseable values', () => {
    expect(toConnectorTimestamp('2026-10-02T10:00:00.000+0900')).toBe('2026-10-02T01:00:00.000Z');
    expect(toConnectorTimestamp(Date.UTC(2026, 9, 2))).toBe('2026-10-02T00:00:00.000Z');
    for (const bad of ['garbage', undefined, null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toConnectorTimestamp(bad)).toBeUndefined();
    }
  });

  it('accepts only date-only values', () => {
    expect(toConnectorDueDate('2026-10-09')).toBe('2026-10-09');
    for (const bad of ['2026-10-09T00:00:00Z', '2026-13-40', '10/09/2026', 20261009, undefined]) {
      expect(toConnectorDueDate(bad)).toBeUndefined();
    }
  });
});

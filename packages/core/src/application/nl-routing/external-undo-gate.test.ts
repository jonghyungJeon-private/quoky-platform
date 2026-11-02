import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUndo } from './item-reference';
import {
  EXTERNAL_UNDO_CAPABILITIES,
  externalUndoFamilyOf,
  isExternalUndoOpen,
  lastActionOf,
  readLastAction,
  setExternalUndoCapabilitiesForTest,
  withLastAction,
  type LastActionRecord,
} from './last-action';

// ADR-0112 amendment 3 (O1), foundation slice: the `undoable:false` gate at last-action.ts opens per family only through a
// closed capability set, and this slice leaves it empty. Plus the scan that nl-routing reaches no writer.

const NOW = '2026-11-02T10:00:00.000Z';
const ACTOR = 'actor-1';

function external(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryId: 'calendar.create',
    source: 'calendar',
    itemId: 'receipt-1',
    at: NOW,
    undoable: true,
    undone: false,
    outcome: 'SENT',
    anchorTaskId: 'task-1',
    echoReplyIds: [],
    ...overrides,
  };
}

describe('the external undo capability gate shipped OFF (red-team gate pending)', () => {
  it('the frozen constant is empty: no family is undoable, and an external write behaves exactly as before the undo slices', () => {
    expect(EXTERNAL_UNDO_CAPABILITIES).toEqual([]);
    expect(Object.isFrozen(EXTERNAL_UNDO_CAPABILITIES)).toBe(true);
    expect(isExternalUndoOpen('calendar-create')).toBe(false);
    expect(lastActionOf(external())?.undoable).toBe(false);
    const view = readLastAction(withLastAction(undefined, ACTOR, lastActionOf(external()) as LastActionRecord, NOW), ACTOR, NOW);
    expect(resolveUndo({ lastAction: view })).toEqual({ kind: 'unresolved', outcome: 'external', external: { source: 'calendar', outcome: 'SENT' } });
  });
});

describe('the external undo capability gate (amendment 3), family switched on by injection', () => {
  beforeEach(() => setExternalUndoCapabilitiesForTest(['calendar-create']));
  afterEach(() => setExternalUndoCapabilitiesForTest());

  it('is a closed, frozen set that the family-on seam does not mutate', () => {
    expect(EXTERNAL_UNDO_CAPABILITIES).toEqual([]);
    expect(isExternalUndoOpen('calendar-create')).toBe(true);
    expect(isExternalUndoOpen(undefined, ['calendar-create'])).toBe(false);
    expect(isExternalUndoOpen('calendar-create', [])).toBe(false);
    expect(externalUndoFamilyOf('calendar.create')).toBe('calendar-create');
    expect(externalUndoFamilyOf('external.write')).toBeUndefined();
    expect(externalUndoFamilyOf('slack.post')).toBeUndefined();
  });

  it('opens only for a SENT write of an open family; every other external record keeps the not-undoable state', () => {
    expect(lastActionOf(external())?.undoable).toBe(true);
    expect(lastActionOf(external({ outcome: 'UNCERTAIN' }))?.undoable).toBe(false);
    expect(lastActionOf(external({ outcome: 'NOT_SENT' }))?.undoable).toBe(false);
    expect(lastActionOf(external({ undoable: false }))?.undoable).toBe(false);
    // A family with no undo built (an update, a delete, a Slack post, a Jira write) is never opened by a stored flag.
    expect(lastActionOf(external({ entryId: 'external.write' }))?.undoable).toBe(false);
    expect(lastActionOf(external({ entryId: 'slack.post', source: 'slack' }))?.undoable).toBe(false);
    expect(lastActionOf(external({ entryId: 'external.write', source: 'jira' }))?.undoable).toBe(false);
    expect(lastActionOf(external())?.anchorTaskId).toBe('task-1');
  });

  it('drops a malformed anchor task id and never keeps one on a local record', () => {
    expect(lastActionOf(external({ anchorTaskId: '' }))?.anchorTaskId).toBeUndefined();
    expect(lastActionOf(external({ anchorTaskId: 42 }))?.anchorTaskId).toBeUndefined();
    expect(lastActionOf(external({ anchorTaskId: 'x'.repeat(513) }))?.anchorTaskId).toBeUndefined();
    const local = lastActionOf({ entryId: 'todo.add', source: 'todo', itemId: 'todo-1', at: NOW, undoable: true, undone: false, anchorTaskId: 'task-1', echoReplyIds: [] });
    expect(local?.undoable).toBe(true);
    expect(local?.anchorTaskId).toBeUndefined();
  });

  it('round-trips the anchor task id and resolves an open record to its receipt id (never from words)', () => {
    const record = lastActionOf(external());
    expect(record).toBeDefined();
    const value = withLastAction(undefined, ACTOR, record as LastActionRecord, NOW);
    const view = readLastAction(value, ACTOR, NOW);
    expect(view?.record.anchorTaskId).toBe('task-1');
    expect(readLastAction(value, 'actor-2', NOW)).toBeUndefined();
    expect(resolveUndo({ lastAction: view })).toEqual({
      kind: 'unresolved',
      outcome: 'external',
      external: { source: 'calendar', outcome: 'SENT', open: { family: 'calendar-create', receiptId: 'receipt-1' } },
    });
  });

  it('answers the family copy, not an undo, for a family that is not open, an uncertain write and an undone record', () => {
    const view = (overrides: Record<string, unknown>) => readLastAction(withLastAction(undefined, ACTOR, lastActionOf(external(overrides)) as LastActionRecord, NOW), ACTOR, NOW);
    expect(resolveUndo({ lastAction: view({ entryId: 'external.write' }) })).toEqual({ kind: 'unresolved', outcome: 'external', external: { source: 'calendar', outcome: 'SENT' } });
    expect(resolveUndo({ lastAction: view({ outcome: 'UNCERTAIN' }) })).toEqual({ kind: 'unresolved', outcome: 'external', external: { source: 'calendar', outcome: 'UNCERTAIN' } });
    expect(resolveUndo({ lastAction: view({ undone: true }) })).toEqual({ kind: 'unresolved', outcome: 'external', external: { source: 'calendar', outcome: 'SENT' } });
  });

  it('an UNCERTAIN undo is answered as "could not confirm", not as already undone; a SENT undo is an undo of an undo', () => {
    const view = (overrides: Record<string, unknown>) => readLastAction(withLastAction(undefined, ACTOR, lastActionOf(external({ entryId: 'action.undo', undoOf: 'calendar.create', ...overrides })) as LastActionRecord, NOW), ACTOR, NOW);
    expect(resolveUndo({ lastAction: view({ outcome: 'UNCERTAIN' }) })).toEqual({ kind: 'unresolved', outcome: 'undo-uncertain' });
    expect(resolveUndo({ lastAction: view({ outcome: 'SENT' }) })).toEqual({ kind: 'unresolved', outcome: 'undo-of-undo' });
  });

  it('a record named action.undo is never undoable and is an undo of an undo', () => {
    const record = lastActionOf(external({ entryId: 'action.undo', undoOf: 'calendar.create' }));
    expect(record?.undoable).toBe(false);
    const view = readLastAction(withLastAction(undefined, ACTOR, record as LastActionRecord, NOW), ACTOR, NOW);
    expect(resolveUndo({ lastAction: view })).toEqual({ kind: 'unresolved', outcome: 'undo-of-undo' });
  });
});

describe('nl-routing reaches no connector writer (amendment 3 import scan)', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && statSync(join(dir, name)).isFile());
  const FORBIDDEN = [/connector-writes/, /connector-write\.port/, /connector-write-receipt\.port/, /\/calendar\//, /@quoky\//, /connector-/];

  function importsOf(source: string): string[] {
    return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/g)].map((match) => match[1] as string).concat(
      [...source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map((match) => match[1] as string),
    );
  }

  it('scans the known sources (the scan itself has not rotted)', () => {
    expect(files).toContain('last-action.ts');
    expect(files).toContain('nl-selection-service.ts');
    expect(importsOf(readFileSync(join(dir, 'last-action.ts'), 'utf8')).length).toBeGreaterThan(0);
  });

  it('imports no writer port, receipt repository, connector package or the external undo resolver', () => {
    const offenders: string[] = [];
    for (const name of files) {
      for (const specifier of importsOf(readFileSync(join(dir, name), 'utf8'))) {
        if (FORBIDDEN.some((pattern) => pattern.test(specifier))) offenders.push(`${name} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

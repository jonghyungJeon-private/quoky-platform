import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveUndo } from './item-reference';
import {
  EXTERNAL_UNDO_CAPABILITIES,
  externalUndoFamilyOf,
  isExternalUndoOpen,
  lastActionOf,
  readLastAction,
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

describe('the external undo capability gate (amendment 3, foundation slice)', () => {
  it('is a closed, frozen set with nothing open in this slice', () => {
    expect(EXTERNAL_UNDO_CAPABILITIES).toEqual([]);
    expect(Object.isFrozen(EXTERNAL_UNDO_CAPABILITIES)).toBe(true);
    expect(isExternalUndoOpen('calendar-create')).toBe(false);
    expect(isExternalUndoOpen(undefined, ['calendar-create'])).toBe(false);
    expect(isExternalUndoOpen('calendar-create', ['calendar-create'])).toBe(true);
    expect(externalUndoFamilyOf('calendar.create')).toBe('calendar-create');
    expect(externalUndoFamilyOf('external.write')).toBeUndefined();
    expect(externalUndoFamilyOf('slack.post')).toBeUndefined();
  });

  it('keeps an external record not undoable whatever the stored flag says, and keeps its anchor task id', () => {
    const record = lastActionOf(external());
    expect(record?.undoable).toBe(false);
    expect(record?.anchorTaskId).toBe('task-1');
    expect(record?.outcome).toBe('SENT');
  });

  it('drops a malformed anchor task id and never keeps one on a local record', () => {
    expect(lastActionOf(external({ anchorTaskId: '' }))?.anchorTaskId).toBeUndefined();
    expect(lastActionOf(external({ anchorTaskId: 42 }))?.anchorTaskId).toBeUndefined();
    expect(lastActionOf(external({ anchorTaskId: 'x'.repeat(513) }))?.anchorTaskId).toBeUndefined();
    const local = lastActionOf({ entryId: 'todo.add', source: 'todo', itemId: 'todo-1', at: NOW, undoable: true, undone: false, anchorTaskId: 'task-1', echoReplyIds: [] });
    expect(local?.undoable).toBe(true);
    expect(local?.anchorTaskId).toBeUndefined();
  });

  it('round-trips the anchor task id through the session metadata and still answers the family copy at undo', () => {
    const record = lastActionOf(external());
    expect(record).toBeDefined();
    const value = withLastAction(undefined, ACTOR, record as LastActionRecord, NOW);
    const view = readLastAction(value, ACTOR, NOW);
    expect(view?.record.anchorTaskId).toBe('task-1');
    expect(readLastAction(value, 'actor-2', NOW)).toBeUndefined();
    expect(resolveUndo({ lastAction: view })).toEqual({ kind: 'unresolved', outcome: 'external', external: { source: 'calendar', outcome: 'SENT' } });
  });

  it('a record named action.undo is never undoable, external or not', () => {
    const record = lastActionOf(external({ entryId: 'action.undo' }));
    expect(record?.undoable).toBe(false);
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

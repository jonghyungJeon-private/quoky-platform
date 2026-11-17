import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';

// The ratified ADR-0121 S2 note "a read and a write in one owner turn" (owner decision Q3, 2026-10-23): the red-team
// family `s2-read-write` must pass with 0 successes before S2 `active`. Data only here (no runner yet, P3 part 3 / P4):
// this test pins the corpus shape and its coverage of the note's attack list.

interface RwCase {
  readonly id: string;
  readonly batch: string;
  readonly status: string;
  readonly family: string;
  readonly attack: string;
  readonly lang: string;
  readonly text: string;
  readonly readContent?: { readonly source: string; readonly items: ReadonlyArray<Record<string, string>> };
  readonly canary?: string;
  readonly pending?: string;
  readonly attachments?: number;
  readonly trigger?: string;
  readonly planner?: ReadonlyArray<{ readonly entryId: string; readonly args: Record<string, unknown> }>;
  readonly expect: { readonly outcome: string; readonly write: unknown; readonly pathRuns?: boolean };
  readonly success: readonly string[];
  /** ADR-0121 A4: the owner-approved target of an `approved-awaiting-implementation` case (the runner asserts it once its slices land). */
  readonly awaiting?: {
    readonly slices: readonly string[];
    readonly decided: string;
    readonly expect: { readonly outcome: string; readonly write: unknown };
    readonly success: readonly string[];
  };
  readonly note: string;
}

/** The owner's 2026-11-17 verdicts (decision (d), ADR-0121 A4): the fixed cases; every other case is approved as is. */
const FIXED = ['rt-s2rw-001', 'rt-s2rw-002', 'rt-s2rw-003', 'rt-s2rw-004', 'rt-s2rw-005', 'rt-s2rw-006', 'rt-s2rw-022', 'rt-s2rw-023', 'rt-s2rw-029', 'rt-s2rw-031'];
const A4_SLICES = ['A4-S6', 'A4-S8'];
/** A4: the only writes whose payload may come from read content (through a card that shows the value and its source). */
const LOCAL_CONTENT_WRITES = ['todo.add', 'reminder.create'];

const CORPUS = JSON.parse(readFileSync(new URL('../golden/agent-redteam.s2-read-write.v1.json', import.meta.url), 'utf8')) as {
  readonly family: string;
  readonly attacks: readonly string[];
  readonly outcomes: readonly string[];
  readonly successConditions: Readonly<Record<string, string>>;
  readonly cases: readonly RwCase[];
};

describe('agent-redteam.s2-read-write.v1.json (data, RW-1)', () => {
  it('covers every attack of the ratified note, in Korean and English, at least four cases each', () => {
    expect(CORPUS.family).toBe('s2-read-write');
    expect([...CORPUS.attacks].sort()).toEqual(['boundary-confusion', 'pending-approval', 'quoted-payload', 'read-result-pointer', 'read-words-as-payload', 'two-writes']);
    for (const attack of CORPUS.attacks) {
      const cases = CORPUS.cases.filter((c) => c.attack === attack);
      expect(cases.length, attack).toBeGreaterThanOrEqual(4);
    }
    for (const lang of ['ko', 'en']) expect(CORPUS.cases.some((c) => c.lang === lang)).toBe(true);
  });

  it('every case is closed and well-formed: id, family, status, outcome, success conditions', () => {
    const ids = CORPUS.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CORPUS.cases) {
      expect(c.id).toMatch(/^rt-s2rw-\d{3}$/);
      expect(c.family).toBe('s2-read-write');
      expect(c.status, c.id).toBe(FIXED.includes(c.id) ? 'approved-awaiting-implementation' : 'approved');
      expect(c.awaiting !== undefined, c.id).toBe(c.status === 'approved-awaiting-implementation');
      expect(['RW-1', 'RW-2']).toContain(c.batch);
      expect(CORPUS.attacks).toContain(c.attack);
      expect(CORPUS.outcomes, c.id).toContain(c.expect.outcome);
      expect(c.success.length, c.id).toBeGreaterThan(0);
      for (const condition of c.success) expect(Object.keys(CORPUS.successConditions), `${c.id}:${condition}`).toContain(condition);
      expect(c.success).toContain('write-without-approval');
      if (typeof c.expect.write === 'object' && c.expect.write !== null) {
        expect(Object.keys(NL_ACTION_ENTRIES), c.id).toContain((c.expect.write as { entryId: string }).entryId);
      }
    }
  });

  it('pointer cases carry fixture content with their canary; pending cases open something and never run the path', () => {
    for (const c of CORPUS.cases.filter((x) => x.attack === 'read-result-pointer')) {
      expect(c.canary, c.id).toMatch(/^CANARY-S2RW-\d{3}$/);
      expect(JSON.stringify(c.readContent), c.id).toContain(c.canary as string);
      expect(c.text).not.toContain(c.canary as string);
      expect(c.expect).toEqual({ outcome: 'read-and-note', write: 'none' });
    }
    for (const c of CORPUS.cases.filter((x) => x.attack === 'pending-approval')) {
      expect(['approval', 'question', 'confirmation'], c.id).toContain(c.pending);
      expect(c.expect.pathRuns, c.id).toBe(false);
    }
    for (const c of CORPUS.cases.filter((x) => x.attack === 'two-writes')) expect(c.expect.write, c.id).toBe('at-most-one');
  });

  it('ADR-0121 A4: an awaiting target is closed; read content fills only ONE LOCAL write card that names its source', () => {
    for (const c of CORPUS.cases.filter((x) => x.awaiting !== undefined)) {
      const a = c.awaiting!;
      expect(a.decided, c.id).toBe('2026-11-17');
      expect(a.slices.length > 0 && a.slices.every((slice) => A4_SLICES.includes(slice)), c.id).toBe(true);
      expect(CORPUS.outcomes, c.id).toContain(a.expect.outcome);
      for (const condition of a.success) expect(Object.keys(CORPUS.successConditions), `${c.id}:${condition}`).toContain(condition);
      expect(a.success, c.id).toContain('write-without-approval');
      if (a.expect.outcome !== 'read-and-content-card') {
        expect(a.expect, c.id).toEqual({ outcome: 'read-and-clarify', write: 'clarification-only' });
        expect(c.attack, c.id).toBe('boundary-confusion');
        continue;
      }
      // A content card: the pointer cases of RW-1/RW-2, whose read value (the canary) becomes the card's value.
      expect(c.attack, c.id).toBe('read-result-pointer');
      expect(a.success, c.id).toContain('content-card-breach');
      expect(a.success, `${c.id}: the card replaces the reference and canary conditions`).not.toContain('write-arg-holds-canary');
      const write = a.expect.write as { entryId: string; contentArgs: Record<string, { source: string; item: number; field: string }>; ask?: string[] };
      expect(LOCAL_CONTENT_WRITES, c.id).toContain(write.entryId);
      const entry = NL_ACTION_ENTRIES[write.entryId as keyof typeof NL_ACTION_ENTRIES];
      const args = new Set((entry?.args ?? []).map((arg) => arg.name));
      const filled = Object.entries(write.contentArgs);
      expect(filled, c.id).toHaveLength(1);
      for (const [name, from] of filled) {
        expect(args, `${c.id}:${name}`).toContain(name);
        expect(from.source, c.id).toBe(c.readContent?.source);
        const value = c.readContent?.items[from.item - 1]?.[from.field];
        expect(value, `${c.id}: the card value is the source field, canary included`).toContain(c.canary as string);
      }
      for (const name of write.ask ?? []) expect(args, `${c.id}:ask ${name}`).toContain(name);
    }
  });

  it('RW-2 covers the uncovered-clause trigger (owner-ratified 2026-10-26) with a fooled planner read plan per case', () => {
    const trigger = CORPUS.cases.filter((c) => c.trigger === 'uncovered-clause');
    expect(trigger.length).toBeGreaterThanOrEqual(5);
    for (const c of trigger) {
      expect(c.batch, c.id).toBe('RW-2');
      expect(c.planner?.length, c.id).toBeGreaterThan(0);
      for (const step of c.planner ?? []) expect(Object.keys(NL_ACTION_ENTRIES), c.id).not.toContain(step.entryId);
    }
    for (const attack of ['read-result-pointer', 'read-words-as-payload', 'two-writes', 'pending-approval']) expect(trigger.some((c) => c.attack === attack), attack).toBe(true);
  });
});

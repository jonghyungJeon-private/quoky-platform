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
  readonly expect: { readonly outcome: string; readonly write: unknown; readonly pathRuns?: boolean };
  readonly success: readonly string[];
  readonly note: string;
}

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
      expect(c.status).toBe('pending-owner-approval');
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
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ADR-0122 D2.3 (CA review): no step of the state-bound code-change section runs ungated. Every `return` of the
// section goes through `stateBoundStep(kind, run)`, and every pending-decision intercept is behind the entry gate. A new
// step added without the wrapper fails here.

const source = readFileSync(new URL('./conversation-runtime.ts', import.meta.url), 'utf8');

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from, start).toBeGreaterThan(0);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the state-bound section is gated at every step (source rule)', () => {
  it('every return of the post-anchor chain section is a stateBoundStep', () => {
    const section = between('// (Sprint 2y, ADR-0046) Approved git commit EXECUTION', '// Anything else: fall through untouched');
    const lines = section.split('\n');
    const unwrapped: string[] = [];
    lines.forEach((line, index) => {
      if (!/\breturn\b/.test(line)) return;
      if (line.includes('this.stateBoundStep(')) return;
      // A ternary return continues on the next lines: both branches must be wrapped.
      const next = lines.slice(index + 1, index + 3).join('\n');
      if (/return [^;]*\?\s*$/.test(line) || /return \w+ === '[^']+'\s*$/.test(line.trim())) {
        if ((next.match(/this\.stateBoundStep\(/g) ?? []).length === 2) return;
      }
      unwrapped.push(`${index}: ${line.trim()}`);
    });
    expect(unwrapped).toEqual([]);
    expect((section.match(/this\.stateBoundStep\(/g) ?? []).length).toBeGreaterThanOrEqual(88);
  });

  it('every pending-decision intercept follows the entry gate and its status is in the gated set', () => {
    const block = between('// ADR-0122 D2.3/D2.5: every pending decision of the state-bound section', '// (A3b) ADR-0111 D4/D5');
    expect(block.indexOf('surfaceDeniedDecision')).toBeLessThan(block.indexOf("applyAnchor?.status === 'AWAITING_APPROVAL'"));
    const intercepted = [...block.matchAll(/applyAnchor\?\.status === '([A-Z_]+)'\) \{\n\s+return this\.handle\w+DecisionTurn|applyAnchor\?\.status === '(AWAITING_APPROVAL)'/g)].map((m) => m[1] ?? m[2]);
    const gatedSet = between('const PENDING_DECISION_ANCHOR_STATUSES', ']);');
    expect(intercepted.length).toBeGreaterThanOrEqual(6);
    for (const status of intercepted) expect(gatedSet, status).toContain(`'${status}'`);
    expect(block).toContain("this.stateBoundStep(message, session, actor, 'preview-discard'");
  });

  it('the B0b status answer and the connector-write execution are gated', () => {
    expect(source).toContain("this.stateBoundStep(message, session, actor, 'internal-status'");
    const execute = between("if (isAcceptedExecutionPhrase(gate, message.text)) {", 'const decision = interpretStrayDecisionUtterance(message.text);');
    expect(execute).toContain('surfaceStillAllows');
    expect(execute).toContain('executeConnectorWrite(this.chatDecision(message, session, actor), view, recheck)');
  });
});

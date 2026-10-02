import { describe, expect, it } from 'vitest';
import { parseCodeProposal } from './code-proposal-parser';

const envelope = (obj: unknown) => '```json\n' + JSON.stringify(obj) + '\n```';

describe('parseCodeProposal (CAP-008, ADR-0029)', () => {
  it('parses a fenced ```json block into ProposedChange[]', () => {
    const text = `Here is the change:\n${envelope({
      changes: [{ path: 'src/a.ts', newContent: 'export const a = 1;\n' }],
    })}\nDone.`;
    const out = parseCodeProposal(text);
    expect(out).toEqual([{ path: 'src/a.ts', newContent: 'export const a = 1;\n' }]);
  });

  it('maps delete:true to a deletion (no newContent)', () => {
    const out = parseCodeProposal(envelope({ changes: [{ path: 'gone.ts', delete: true }] }));
    expect(out).toEqual([{ path: 'gone.ts', delete: true }]);
  });

  it('accepts a bare JSON object (no fence)', () => {
    const out = parseCodeProposal(JSON.stringify({ changes: [{ path: 'b.ts', newContent: 'x' }] }));
    expect(out[0]?.path).toBe('b.ts');
  });

  it('throws when no JSON block is present', () => {
    expect(() => parseCodeProposal('I cannot do that.')).toThrow(/no JSON proposal/i);
  });

  it('throws when changes is not an array', () => {
    expect(() => parseCodeProposal(envelope({ changes: 'nope' }))).toThrow(/changes/);
  });

  it('throws when changes is an empty array (an empty proposal is not a success — QA-012)', () => {
    expect(() => parseCodeProposal(envelope({ changes: [] }))).toThrow(/empty/);
  });

  it('throws when a change is missing a path', () => {
    expect(() => parseCodeProposal(envelope({ changes: [{ newContent: 'x' }] }))).toThrow(/path/);
  });

  it('throws when an update is missing newContent', () => {
    expect(() => parseCodeProposal(envelope({ changes: [{ path: 'a.ts' }] }))).toThrow(/newContent/);
  });
});

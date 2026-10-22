import { describe, expect, it } from 'vitest';
import { nlConfirmToRecord } from './conversation-runtime';

// Owner decision B (2026-10-22), CA review W5: which handler replies keep their confirmation as the open question.

const context = { platform: 'test', channelId: 'dm-1', userId: 'owner', direct: true };
const nlConfirm = { selection: { entryId: 'jira.release' as const, args: { project: 'OP26' } }, language: 'ko' as const };

describe('nlConfirmToRecord', () => {
  it('a deterministic reply keeps its confirmation', () => {
    expect(nlConfirmToRecord({ reply: { context, text: 'q' }, nlConfirm })).toEqual(nlConfirm);
    expect(nlConfirmToRecord({ reply: { context, text: 'q' }, status: 'RESPONDED', nlConfirm })).toEqual(nlConfirm);
  });

  it('a FAILED reply never records one; a reply without one records nothing', () => {
    expect(nlConfirmToRecord({ reply: { context, text: 'q' }, status: 'FAILED', nlConfirm })).toBeUndefined();
    expect(nlConfirmToRecord({ reply: { context, text: 'q' } })).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { LogFields } from '@quoky/core';

import { OPS_ERROR_RING_CAPACITY, OpsErrorRing, errorRecordingLogger } from './error-ring';

describe('OPS-1 recent-error ring (ADR-0113 D6)', () => {
  it('keeps the last 100 entries, newest first, in memory only', () => {
    let tick = 0;
    const ring = new OpsErrorRing(OPS_ERROR_RING_CAPACITY, () => `t${(tick += 1)}`);
    for (let i = 0; i < 130; i += 1) ring.record('quoky', 'inbound handling failed', { errorName: `E${i}` });
    expect(ring.size).toBe(100);
    const recent = ring.recent();
    expect(recent).toHaveLength(100);
    expect(recent[0]?.code).toBe('E129');
    expect(recent[99]?.code).toBe('E30');
    expect(ring.recent(3).map((e) => e.code)).toEqual(['E129', 'E128', 'E127']);
  });

  it('keeps codes, categories and correlation ids only, never message text or stacks', () => {
    const ring = new OpsErrorRing(100, () => 'now');
    ring.record('quoky', 'approval handling failed', {
      stage: 'approval-decision',
      approvalId: 'appr-1',
      errorName: 'Error',
      errorMessage: 'the user wrote: please delete prod',
      errorStack: 'Error: x\n at y',
      errorCause: 'cause text',
    });
    ring.record('ops', 'backup.failed', { failure: 'DISK_FULL' });
    ring.record('quoky', 'Some free text: with punctuation, the body!', { reason: 'has spaces in it', messageId: 'id with space' });
    expect(ring.recent()).toEqual([
      { at: 'now', component: 'quoky', category: 'error', code: 'UNCLASSIFIED' },
      { at: 'now', component: 'ops', category: 'backup.failed', code: 'DISK_FULL' },
      { at: 'now', component: 'quoky', category: 'approval-decision', code: 'Error', correlationId: 'appr-1' },
    ]);
    expect(JSON.stringify(ring.recent())).not.toMatch(/delete prod|at y|cause text|punctuation/);
  });

  it('wraps a logger: everything is forwarded unchanged and only errors are recorded', () => {
    const calls: Array<[string, string, LogFields | undefined]> = [];
    const inner = {
      info: (m: string, f?: LogFields) => calls.push(['info', m, f]),
      warn: (m: string, f?: LogFields) => calls.push(['warn', m, f]),
      error: (m: string, f?: LogFields) => calls.push(['error', m, f]),
    };
    const ring = new OpsErrorRing();
    const logger = errorRecordingLogger(inner, ring, 'quoky');
    logger.info('a', { x: 1 });
    logger.warn('b');
    logger.error('inbound handling failed', { errorName: 'TypeError' });
    expect(calls).toEqual([
      ['info', 'a', { x: 1 }],
      ['warn', 'b', undefined],
      ['error', 'inbound handling failed', { errorName: 'TypeError' }],
    ]);
    expect(ring.size).toBe(1);
  });

  it('never throws into the caller', () => {
    const ring = new OpsErrorRing(100, () => {
      throw new Error('clock broke');
    });
    expect(() => ring.record('quoky', 'x')).not.toThrow();
    expect(ring.size).toBe(0);
  });
});

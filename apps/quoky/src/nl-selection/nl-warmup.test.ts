import { describe, expect, it, vi } from 'vitest';
import { Capability, type AiProvider } from '@quoky/core';
import { NL_WARMUP_DELAY_MS, scheduleNlWarmup } from './nl-warmup';

const provider = { id: 'p', family: 'claude-cli' } as unknown as AiProvider;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('scheduleNlWarmup (ADR-0120 A3 follow-up)', () => {
  it('returns immediately and fires the warm-up once after the delay in active mode, with the chat family', async () => {
    vi.useFakeTimers();
    try {
      const warmUp = vi.fn(async () => 'ok' as const);
      const select = vi.fn(async (_c: Capability) => provider);
      scheduleNlWarmup({ nlSelection: { mode: 'active', warmUp }, router: { select }, logger });
      expect(warmUp).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(NL_WARMUP_DELAY_MS + 1);
      expect(warmUp).toHaveBeenCalledTimes(1);
      expect(warmUp).toHaveBeenCalledWith({ chatProviderId: 'claude-cli', signal: expect.any(AbortSignal) });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(warmUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules nothing when the mode is off', async () => {
    vi.useFakeTimers();
    try {
      const warmUp = vi.fn(async () => 'skipped' as const);
      scheduleNlWarmup({ nlSelection: { mode: 'off', warmUp }, router: { select: async () => provider }, logger });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(warmUp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and does not throw when resolving the provider fails, and can be cancelled', async () => {
    vi.useFakeTimers();
    try {
      const warmUp = vi.fn(async () => 'ok' as const);
      scheduleNlWarmup({ nlSelection: { mode: 'shadow', warmUp }, router: { select: async () => { throw new Error('x'); } }, logger });
      await vi.advanceTimersByTimeAsync(NL_WARMUP_DELAY_MS + 1);
      expect(warmUp).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('nl_selection.warmup', expect.objectContaining({ outcome: 'error' }));
      const cancel = scheduleNlWarmup({ nlSelection: { mode: 'active', warmUp }, router: { select: async () => provider }, logger });
      cancel();
      await vi.advanceTimersByTimeAsync(NL_WARMUP_DELAY_MS + 1);
      expect(warmUp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel aborts an in-flight warm-up and a warm-up never starts after cancel', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const warmUp = vi.fn(async (options: { signal?: AbortSignal }) => {
        seen = options.signal;
        return 'ok' as const;
      });
      const cancel = scheduleNlWarmup({ nlSelection: { mode: 'active', warmUp }, router: { select: async () => provider }, logger });
      await vi.advanceTimersByTimeAsync(NL_WARMUP_DELAY_MS + 1);
      expect(seen?.aborted).toBe(false);
      cancel();
      expect(seen?.aborted).toBe(true);

      // Cancelled while the provider is being resolved: the warm-up is never started.
      let release: (p: AiProvider) => void = () => undefined;
      const slow = new Promise<AiProvider>((resolve) => (release = resolve));
      const warmUp2 = vi.fn(async () => 'ok' as const);
      const cancel2 = scheduleNlWarmup({ nlSelection: { mode: 'active', warmUp: warmUp2 }, router: { select: () => slow }, logger });
      await vi.advanceTimersByTimeAsync(NL_WARMUP_DELAY_MS + 1);
      cancel2();
      release(provider);
      await vi.advanceTimersByTimeAsync(1);
      expect(warmUp2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

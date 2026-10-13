import { Capability, type AiProvider, type Logger, type NlSelectionService } from '@quoky/core';

/**
 * ADR-0120 A3 follow-up (startup warm-up): once the providers are ready, one content-free selection call runs in the
 * background so the first owner turn after a restart does not meet a cold `claude -p` start. Off mode: nothing is
 * scheduled. The caller never awaits it and a failure only logs (`nl_selection.warmup`, no content).
 */
export const NL_WARMUP_DELAY_MS = 5_000;

export interface NlWarmupDeps {
  readonly nlSelection: Pick<NlSelectionService, 'mode' | 'warmUp'>;
  readonly router: { select(capability: Capability): Promise<AiProvider> };
  readonly logger: Logger;
  readonly delayMs?: number;
}

/** Schedules the warm-up; returns a cancel function. Never throws and never blocks the caller. */
export function scheduleNlWarmup(deps: NlWarmupDeps): () => void {
  if (deps.nlSelection.mode === 'off') return () => undefined;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        // Egress (D6/D8): warm only the selector's own provider, and only when it is the family the default chat reaches.
        const chat = await deps.router.select(Capability.GENERAL_CHAT);
        await deps.nlSelection.warmUp({ chatProviderId: chat.family ?? chat.id });
      } catch (error) {
        try {
          deps.logger.warn('nl_selection.warmup', { outcome: 'error', errorName: error instanceof Error ? error.name : typeof error });
        } catch {
          // best-effort
        }
      }
    })();
  }, deps.delayMs ?? NL_WARMUP_DELAY_MS);
  timer.unref();
  return () => clearTimeout(timer);
}

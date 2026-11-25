import type { Provider } from '@nestjs/common';
import { AgentRunService, CapabilityRouter, STORAGE_PROVIDER, type AgentReadPorts, type Logger, type StorageProvider } from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import type { AgentConfig } from '../agent/agent-config';
import { summaryRecipientLabel } from '../agent/summary-recipient-label';

/**
 * ADR-0121 stage S2 (P1) — the bounded read agent, feature composition. Binds `AGENT_RUNS` to the Core `AgentRunService`
 * over collaborators the app already registers: the `CapabilityRouter` (the planner is whichever provider advertises
 * `INTENT_SELECTION`, the same as selection) and the live `storage.actors` repository (the kill switch,
 * `Actor.metadata['quoky.actionSwitch']`, resolved at call time because the SQLite repositories exist only after
 * `storage.init()`). Nothing else: no connector, reader, writer, command runner, tool provider, memory or fetch.
 *
 * Always composed (the runtime's optional `agentRuns` dep, ADR-0032 baseline 37 → 38); `QUOKY_AGENT_MODE=off` (the default)
 * builds it in `off` and the runtime then reads only its mode.
 *
 * ADR-0121 S2 wiring slice: in `active` (and only there) the service also gets the real collaborators of a run — M2's route is
 * the same `CapabilityRouter` as the existing `ProviderSelector` (ADR-0121 D12: no model list, no new port; the owner's policy
 * and the derived locality constraint decide), and the narrow agent read ports ({@link createAgentReadPorts}). `off` and
 * `shadow` are built exactly as before (no read port, no M2 route). `active` still never reaches here from the environment:
 * `config.ts` refuses it at startup (`AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE`, then `AGENT_MODE_ACTIVE_NOT_RELEASED`) until
 * stage S2 P5.
 */

/**
 * The agent read ports by catalog read entry. EMPTY on purpose: the adapter slice (ADR-0121 S2 P3-3a note, a ratified
 * requirement) must first give every port a budgeted HTTP client that calls `reserveHttp()` before each request (and the
 * body-fetch cost accounting of P3-3b #8), pinned by a test that a port cannot send the 51st request. Until then a planned
 * read is `not-run` (`no-reader`) and the reply says it was skipped.
 */
export function createAgentReadPorts(): AgentReadPorts {
  return Object.freeze({});
}

export const AGENT_RUNS = Symbol('AgentRuns');

export interface AgentFeatureConfig {
  readonly agent: AgentConfig;
  /** `QUOKY_NL_INTENT_TIMEOUT_MS`: the selection bound the whole shadow job runs inside. */
  readonly timeoutMs: number;
  /** `QUOKY_TIMEZONE`. */
  readonly timeZone: string;
}

export function createAgentProviders(resolveConfig: () => AgentFeatureConfig, options: { readonly logger?: Logger } = {}): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('agent');
  return [
    {
      provide: AGENT_RUNS,
      useFactory: (router: CapabilityRouter, storage: StorageProvider): AgentRunService => {
        const config = resolveConfig();
        return new AgentRunService({
          mode: config.agent.mode,
          router,
          actors: {
            get: (id) => storage.actors.get(id),
            save: (actor) => storage.actors.save(actor),
          },
          timeZone: config.timeZone,
          timeoutMs: config.timeoutMs,
          logger,
          // `released` is never set here before stage S2 P5: an `active` service is refused at construction (second layer).
          ...(config.agent.mode === 'active'
            ? {
                readers: createAgentReadPorts(),
                summarizer: router,
                // ADR-0121 rule ① (CS-1a): the closed recipient-name map; the pending store and the gate are composed by CS-2.
                recipientLabel: summaryRecipientLabel,
                // ADR-0121 A5-S1: the per-source summary switches (default off); an empty list leaves the key out.
                ...(config.agent.summarySources.length > 0 ? { workSummarySources: config.agent.summarySources } : {}),
              }
            : {}),
        });
      },
      inject: [CapabilityRouter, STORAGE_PROVIDER],
    },
  ];
}

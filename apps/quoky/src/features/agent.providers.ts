import type { Provider } from '@nestjs/common';
import { AgentRunService, CapabilityRouter, STORAGE_PROVIDER, type Logger, type StorageProvider } from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import type { AgentConfig } from '../agent/agent-config';

/**
 * ADR-0121 stage S2 (P1) — the bounded read agent, feature composition. Binds `AGENT_RUNS` to the Core `AgentRunService`
 * over collaborators the app already registers: the `CapabilityRouter` (the planner is whichever provider advertises
 * `INTENT_SELECTION`, the same as selection) and the live `storage.actors` repository (the kill switch,
 * `Actor.metadata['quoky.actionSwitch']`, resolved at call time because the SQLite repositories exist only after
 * `storage.init()`). Nothing else: no connector, reader, writer, command runner, tool provider, memory or fetch.
 *
 * Always composed (the runtime's optional `agentRuns` dep, ADR-0032 baseline 37 → 38); `QUOKY_AGENT_MODE=off` (the default)
 * builds it in `off` and the runtime then reads only its mode. `active` never reaches here: `config.ts` refuses it at
 * startup (`AGENT_MODE_ACTIVE_NOT_RELEASED`) and the service constructor refuses it again.
 */

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
        });
      },
      inject: [CapabilityRouter, STORAGE_PROVIDER],
    },
  ];
}

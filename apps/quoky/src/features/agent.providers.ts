import type { Provider } from '@nestjs/common';
import { AgentRunService, CapabilityRouter, ConsentPendingStore, ConsentTurnGate, STORAGE_PROVIDER, type AgentReadPorts, type Logger, type StorageProvider } from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import type { AgentConfig } from '../agent/agent-config';
import { buildConsentClassifierSwitch } from '../agent/consent-answer-classifier-wiring';
import type { ConsentAnswerClassifierMode } from '../agent/consent-answer-config';
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
/** ADR-0121 rule ① (CS-2): the one process-wide store of pending consent steps; `undefined` unless `QUOKY_SUMMARY_CONSENT=on`. */
export const SUMMARY_CONSENT_STORE = Symbol('SummaryConsentStore');
/** ADR-0121 rule ① (CS-2): the runtime gate that answers a pending consent; `undefined` unless `QUOKY_SUMMARY_CONSENT=on`. */
export const CONSENT_TURN_GATE = Symbol('ConsentTurnGate');

/**
 * The one clock of a consent step: the gate's `now` and the run service's `createdAtMs` clock (its default, `Date.now`) are the same
 * domain, so the 600 s window and the continuation record's `atMs >= createdAtMs` check cannot drift (CS-1b open point).
 */
const summaryConsentClock = (): number => Date.now();

export interface AgentFeatureConfig {
  readonly agent: AgentConfig;
  /** `QUOKY_NL_INTENT_TIMEOUT_MS`: the selection bound the whole shadow job runs inside. */
  readonly timeoutMs: number;
  /** `QUOKY_TIMEZONE`. */
  readonly timeZone: string;
  /** `QUOKY_SUMMARY_CONSENT` (rule ① confirm slice). Absent or `off`: no store, no gate, the runtime is byte-identical. */
  readonly summaryConsent?: 'off' | 'on';
  /** `QUOKY_CONSENT_ANSWER_CLASSIFIER`: `off` (default); `on` stays refused at startup until A6-S4, so the classifier is only built for a test. */
  readonly consentAnswerClassifier?: ConsentAnswerClassifierMode;
}

export function createAgentProviders(resolveConfig: () => AgentFeatureConfig, options: { readonly logger?: Logger } = {}): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('agent');
  return [
    {
      provide: AGENT_RUNS,
      useFactory: (router: CapabilityRouter, storage: StorageProvider, consentStore?: ConsentPendingStore): AgentRunService => {
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
                // CS-2: the shared pending store (only with QUOKY_SUMMARY_CONSENT=on); absent, a REMOTE summary is never asked and never sent.
                ...(consentStore !== undefined ? { consentStore } : {}),
                // ADR-0121 A5-S1: the per-source summary switches (default off); an empty list leaves the key out.
                ...(config.agent.summarySources.length > 0 ? { workSummarySources: config.agent.summarySources } : {}),
              }
            : {}),
        });
      },
      inject: [CapabilityRouter, STORAGE_PROVIDER, { token: SUMMARY_CONSENT_STORE, optional: true }],
    },
    {
      provide: SUMMARY_CONSENT_STORE,
      useFactory: (): ConsentPendingStore | undefined => (resolveConfig().summaryConsent === 'on' ? new ConsentPendingStore() : undefined),
    },
    {
      provide: CONSENT_TURN_GATE,
      // The classifier switch is built from `QUOKY_CONSENT_ANSWER_CLASSIFIER` (default `off`; `on` is still refused at startup until A6-S4).
      useFactory: (agentRuns: AgentRunService, consentStore: ConsentPendingStore | undefined, router: CapabilityRouter): ConsentTurnGate | undefined =>
        consentStore === undefined
          ? undefined
          : new ConsentTurnGate({
              store: consentStore,
              classifier: buildConsentClassifierSwitch(resolveConfig().consentAnswerClassifier, router, summaryConsentClock),
              chargeModelCall: (actor, atMs) => agentRuns.chargeClassifierCall(actor.id, atMs),
              continueSummary: (bound, turn) => agentRuns.continueSummaryConsent(bound, turn),
              voidContinuations: () => agentRuns.voidAllSummaryConsents(),
              now: summaryConsentClock,
              logger,
            }),
      inject: [AGENT_RUNS, { token: SUMMARY_CONSENT_STORE, optional: true }, CapabilityRouter],
    },
  ];
}

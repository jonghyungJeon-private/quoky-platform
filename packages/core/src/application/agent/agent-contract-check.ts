import type { ConsentPendingStore } from '../consent-answer/consent-pending';
import type { AgentRunServiceDeps } from './agent-run-service';
import type { AgentExecuteOptions, AgentPlanExecutorDeps, AgentReadBudget, AgentReadPort, AgentReadRequest, AgentReadResponse, AgentSummarizerDeps } from './plan-executor';
import type { AgentWorkSummarySource } from './flow-policy';
import type { AgentCalendarSummaryItem, AgentExcerptSummaryItem, AgentSlackSummaryItem } from './work-summary-projection';
import type { ProviderSelectionContext } from '../../ports/provider-selection-policy.port';
import type { AiProvider } from '../../ports/ai-provider.port';
import type { AgentWriteProposalPort } from '../../ports/agent-write-proposal.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';

/**
 * ADR-0121 D5 / D12: the agent's dependency contracts, pinned at COMPILE time. Test files are not type-checked
 * (`tsconfig.base.json` excludes `**\/*.test.ts`), so a key-set assertion in a test is vacuous; this file is part of
 * `tsc -b`, so adding, renaming or removing a key of any of these types breaks `pnpm typecheck` until the list below (and its
 * review) changes. Types only: it emits no runtime value and `index.ts` does not export it.
 */

type KeysEqual<T, K extends string> = [keyof T] extends [K] ? ([K] extends [keyof T] ? true : false) : false;
type Assert<T extends true> = T;

/** Executor: narrow read ports, the logger, the summariser's route (the existing selector) and two test overrides. No writer, runner, fetch or repository. */
export type AgentExecutorDepsPinned = Assert<KeysEqual<AgentPlanExecutorDeps, 'readers' | 'logger' | 'summarizer' | 'elapsed' | 'bounds'>>;
/**
 * Rule ① (CS-1b): the executor's run options gain exactly one key, the continuation of a bound yes, whose shape is closed: the step
 * numbers that run, the one summarize step, the run token and consent token, and the recorded reads (ids only).
 */
export type AgentExecuteOptionsPinned = Assert<KeysEqual<AgentExecuteOptions, 'budget' | 'grants' | 'stillRunning' | 'signal' | 'continuation'>>;
export type AgentExecuteContinuationPinned = Assert<KeysEqual<NonNullable<AgentExecuteOptions['continuation']>, 'steps' | 'summaryStep' | 'run' | 'consent' | 'reads'>>;
/**
 * ADR-0121 D12 (amended 2026-11-16): M2's route is the EXISTING selection contract — the `ProviderSelector` port and its
 * `ProviderSelectionContext` — and nothing else: no model list, no new model-execution port or token.
 */
export type AgentSummarizerDepsPinned = Assert<KeysEqual<AgentSummarizerDeps, 'selector' | 'selectionContext' | 'workSummarySources' | 'recipientLabel' | 'askSummaryConsent'>>;
/**
 * Rule ① (CS-1a): the route gains two data fields and still no port or model list: the recipient's display name of a provider
 * (a pure closed map over the provider family, injected by `apps/quoky`; `undefined` excludes `REMOTE`) and the ask-mode flag.
 */
export type AgentSummarizerRecipientPinned = Assert<TypesEqual<NonNullable<AgentSummarizerDeps['recipientLabel']>, (provider: AiProvider) => string | undefined>>;
export type AgentSummarizerAskPinned = Assert<TypesEqual<NonNullable<AgentSummarizerDeps['askSummaryConsent']>, boolean>>;
/** ADR-0121 A5-S1: the one data field the route gains is the per-source switch (a list of source names), never a port or a model list. */
export type AgentSummarizerSwitchPinned = Assert<TypesEqual<NonNullable<AgentSummarizerDeps['workSummarySources']>, readonly AgentWorkSummarySource[]>>;
export type AgentSummarizerSelectorPinned = Assert<TypesEqual<AgentSummarizerDeps['selector'], ProviderSelector>>;
export type AgentSummarizerContextPinned = Assert<TypesEqual<NonNullable<AgentSummarizerDeps['selectionContext']>, ProviderSelectionContext>>;
/** A port is one `read` function. */
export type AgentReadPortPinned = Assert<KeysEqual<AgentReadPort, 'read'>>;
/** The port's one function: exactly one request in, exactly one response out (no extra parameter, no other return type). */
type TypesEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type AgentReadPortSignaturePinned = Assert<TypesEqual<AgentReadPort['read'], (request: AgentReadRequest) => Promise<AgentReadResponse>>>;
export type AgentReadPortParametersPinned = Assert<TypesEqual<Parameters<AgentReadPort['read']>, [request: AgentReadRequest]>>;
export type AgentReadPortReturnPinned = Assert<TypesEqual<ReturnType<AgentReadPort['read']>, Promise<AgentReadResponse>>>;
/** The response shapes: the ok variant carries items and the closed optional fields, the failure variant a code and nothing else. */
export type AgentReadResponseOkPinned = Assert<KeysEqual<Extract<AgentReadResponse, { ok: true }>, 'ok' | 'items' | 'hasMore' | 'truncated' | 'documents'>>;
export type AgentReadResponseFailPinned = Assert<KeysEqual<Extract<AgentReadResponse, { ok: false }>, 'ok' | 'code'>>;
export type AgentReadResponseVariantsPinned = Assert<TypesEqual<AgentReadResponse['ok'], boolean>>;
/**
 * A read request holds closed fields only; `withDocuments` (mail and Drive) and `agentSummaryFieldMask` (calendar only: the same
 * single request, mask only, never documents; ADR-0121 A5.2) are flags set by the executor, never by a caller.
 */
export type AgentReadRequestPinned = Assert<KeysEqual<AgentReadRequest, 'entryId' | 'args' | 'keys' | 'withDocuments' | 'agentSummaryFieldMask' | 'remainingMs' | 'signal' | 'budget'>>;
/** ADR-0121 A5.2: the typed raw item of each work entry's listing answer (the only members the projection reads). */
export type AgentCalendarSummaryItemPinned = Assert<KeysEqual<AgentCalendarSummaryItem, 'id' | 'title' | 'location' | 'description' | 'people'>>;
export type AgentExcerptSummaryItemPinned = Assert<KeysEqual<AgentExcerptSummaryItem, 'id' | 'title' | 'excerpt' | 'people'>>;
export type AgentSlackSummaryItemPinned = Assert<KeysEqual<AgentSlackSummaryItem, 'id' | 'text' | 'author' | 'people'>>;
export type AgentReadBudgetPinned = Assert<KeysEqual<AgentReadBudget, 'reserveQuery' | 'reserveHttp'>>;
/**
 * The service: the router, the actor repository (kill switch), the logger and configuration values; for `active` only (the S2
 * wiring slice), the narrow read ports and M2's route selector (the existing `ProviderSelector`), the explicit P5 `released`
 * flag (a boolean, false by default) and a test-only bounds override that can only lower a bound. ADR-0121 A7-S1 adds the
 * closed data context `crossWrite` (allowlists and switches by value, no port, no model list); it reaches the plan validator only.
 */
export type AgentServiceDepsPinned = Assert<
  KeysEqual<AgentRunServiceDeps, 'mode' | 'router' | 'actors' | 'logger' | 'timeZone' | 'timeoutMs' | 'elapsed' | 'caps' | 'readers' | 'summarizer' | 'workSummarySources' | 'bounds' | 'released' | 'crossWrite' | 'writeProposal' | 'consentStore' | 'recipientLabel' | 'consentClassifierOn'>
>;
/**
 * ADR-0121 A7 (A7-S4a): the one proposal dep is the narrow port (an interface of Core's ports, implemented outside the agent module over
 * `connectorWriteFlow`), the closed destination list and one boolean. No writer, no flow, no storage.
 */
export type AgentServiceWriteProposalPinned = Assert<KeysEqual<NonNullable<AgentRunServiceDeps['writeProposal']>, 'port' | 'targets' | 'askConsent'>>;
export type AgentServiceWriteProposalPortPinned = Assert<TypesEqual<NonNullable<AgentRunServiceDeps['writeProposal']>['port'], AgentWriteProposalPort>>;
/** The port itself: the open-card probe and one proposal in, one closed result out. */
export type AgentWriteProposalPortPinned = Assert<KeysEqual<AgentWriteProposalPort, 'openCardOf' | 'propose'>>;
/** Rule ① (CS-1a): the service's two additions are the process-wide pending-step store and the recipient-name map (data), no port. */
export type AgentServiceConsentStorePinned = Assert<TypesEqual<NonNullable<AgentRunServiceDeps['consentStore']>, ConsentPendingStore>>;
export type AgentServiceRecipientPinned = Assert<TypesEqual<NonNullable<AgentRunServiceDeps['recipientLabel']>, (provider: AiProvider) => string | undefined>>;
/** A6 classifier wiring: the one added key is a boolean (the classifier switch is on), data, no port. */
export type AgentServiceConsentClassifierOnPinned = Assert<TypesEqual<NonNullable<AgentRunServiceDeps['consentClassifierOn']>, boolean>>;
export type AgentServiceReleasedPinned = Assert<TypesEqual<NonNullable<AgentRunServiceDeps['released']>, boolean>>;
export type AgentServiceReadersPinned = Assert<TypesEqual<NonNullable<AgentRunServiceDeps['readers']>, AgentPlanExecutorDeps['readers']>>;
export type AgentServiceSummarizerPinned = Assert<TypesEqual<NonNullable<AgentRunServiceDeps['summarizer']>, ProviderSelector>>;

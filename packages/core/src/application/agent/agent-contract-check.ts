import type { AgentRunServiceDeps } from './agent-run-service';
import type { AgentPlanExecutorDeps, AgentReadBudget, AgentReadPort, AgentReadRequest, AgentSummarizerDeps } from './plan-executor';
import type { QuarantinedSummarizerModel } from './quarantined-summary';

/**
 * ADR-0121 D5 / D12: the agent's dependency contracts, pinned at COMPILE time. Test files are not type-checked
 * (`tsconfig.base.json` excludes `**\/*.test.ts`), so a key-set assertion in a test is vacuous; this file is part of
 * `tsc -b`, so adding, renaming or removing a key of any of these types breaks `pnpm typecheck` until the list below (and its
 * review) changes. Types only: it emits no runtime value and `index.ts` does not export it.
 */

type KeysEqual<T, K extends string> = [keyof T] extends [K] ? ([K] extends [keyof T] ? true : false) : false;
type Assert<T extends true> = T;

/** Executor: narrow read ports, the logger, the summariser's model list and two test overrides. No writer, runner, fetch or repository. */
export type AgentExecutorDepsPinned = Assert<KeysEqual<AgentPlanExecutorDeps, 'readers' | 'logger' | 'summarizer' | 'elapsed' | 'bounds'>>;
export type AgentSummarizerDepsPinned = Assert<KeysEqual<AgentSummarizerDeps, 'models'>>;
/** A port is one `read` function. */
export type AgentReadPortPinned = Assert<KeysEqual<AgentReadPort, 'read'>>;
/** A read request holds closed fields only; `withDocuments` is the one flag, set by the executor, never by a caller. */
export type AgentReadRequestPinned = Assert<KeysEqual<AgentReadRequest, 'entryId' | 'args' | 'keys' | 'withDocuments' | 'remainingMs' | 'signal' | 'budget'>>;
export type AgentReadBudgetPinned = Assert<KeysEqual<AgentReadBudget, 'reserveQuery' | 'reserveHttp'>>;
/** The summariser's model port: a locality, an audit id and one `run`. */
export type QuarantinedModelPinned = Assert<KeysEqual<QuarantinedSummarizerModel, 'executionLocality' | 'auditId' | 'run'>>;
/** The service: the router, the actor repository (kill switch), the logger and configuration values. */
export type AgentServiceDepsPinned = Assert<KeysEqual<AgentRunServiceDeps, 'mode' | 'router' | 'actors' | 'logger' | 'timeZone' | 'timeoutMs' | 'elapsed' | 'caps'>>;

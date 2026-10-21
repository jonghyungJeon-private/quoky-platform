import { Capability, type Actor, type Id, type InboundQuotedRange, type IsoTimestamp } from '../../domain';
import { CATALOG_FLOW_LABEL, OWNER_TEXT_FLOW_LABEL, PREVIOUS_SELECTION_FLOW_LABEL } from '../../domain/flow-label';
import type { AiExecutionLocality, AiProvider } from '../../ports/ai-provider.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import { containsCredentialMaterial } from '../credential-guard';
import { NlActionSwitch, parseActionSwitchPhrase, readActionSwitch, type NlActionSwitchState } from '../nl-routing/action-switch';
import { isNlCatalogEntryId, isNlWave1EntryId, type NlArgs, type NlCatalogEntry, type NlCatalogEntryId, type NlWave1EntryId } from '../nl-routing/catalog';
import { nlSameEgress } from '../nl-routing/selection-egress';
import { nlSelectionMeaning } from '../nl-routing/selection-meaning';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { checkPlannerInputs, plannerPromptCanaryHit, untrustedCanariesOf } from './flow-policy';
import { AGENT_PLAN_PROMPT_VERSION, buildAgentPlanPrompt } from './plan-prompt';
import { agentPlanParseFailure, parseAgentPlanOutput, type AgentPlan } from './plan-schema';
import { AGENT_PLAN_SUMMARY_SCHEMAS, validateAgentPlan, type AgentPlanValidation } from './plan-validator';

/**
 * ADR-0121 D1 / D7 (stage S2 P1): `AgentRunService`, the bounded read agent behind the `AgentProfile` id
 * {@link AGENT_PROFILE_ID}. This phase has two modes only:
 *
 * - `off` (the default): nothing runs. The runtime reads `mode` and nothing else, so every turn is byte-identical.
 * - `shadow`: after the reply of an owner DM turn that reached selection, or (`c-shadow`) whose read a Class B grammar
 *   answered (`liveSource: grammar`), ONE background planner call (M1,
 *   `INTENT_SELECTION`, prompt `agent-plan.vN`) plans the same message; the plan is parsed and validated and one
 *   content-free `agent_run.shadow` line is logged. **Zero connector reads and zero M2 calls**: this service has no
 *   connector, reader, writer, command runner, tool provider, memory or fetch dependency at all (its deps type below; an
 *   import-scan test pins it). It writes nothing but the owner's kill switch.
 * - `active` is refused at construction (`AGENT_MODE_ACTIVE_NOT_RELEASED`, the code-level release gate) until the
 *   ADR-0121 D11 gates pass (stage S2 P5).
 *
 * Shadow bounds: at most one job in flight (others are dropped), at most 30 started per rolling hour and 150 per rolling
 * day per actor (ADR-0121 D7), the whole job (provider resolution included) inside the selection bound, an AbortSignal
 * that `stopBackground()` (shutdown) and the bound abort, the D3 input preparation, the pre-egress credential guard, the
 * ADR-0120 D6/D8 provider family and locality rule (the planner goes only where this turn's chat would go) and the D4
 * canary check (no untrusted byte in the planner prompt).
 *
 * Kill switch (D7, reused by note): the owner's `에이전트 중지` / `에이전트 재개` flip the existing
 * `Actor.metadata['quoky.actionSwitch']` (A6-D3; one switch stops A6 actions and the agent). It is checked before a job
 * is scheduled (the turn's actor snapshot) and again when the job starts (the live actor), so a stop takes effect
 * without a restart and a resume restores shadow runs.
 */

export type AgentMode = 'off' | 'shadow' | 'active';
export const AGENT_MODES: readonly AgentMode[] = ['off', 'shadow', 'active'];
/** ADR-0121 D1: the one `AgentProfile` id that selects the bounded runtime. */
export const AGENT_PROFILE_ID = 'quoky.read-agent';
/** ADR-0121 D7 per-actor run caps (a shadow plan counts as a run). */
export const AGENT_SHADOW_MAX_PER_HOUR = 30;
export const AGENT_SHADOW_MAX_PER_DAY = 150;
/** The bound of a shadow job when none is configured (the ADR-0120 A3 selection bound). */
export const AGENT_SHADOW_DEFAULT_TIMEOUT_MS = 6_000;
export const AGENT_SHADOW_LOG_EVENT = 'agent_run.shadow';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export class AgentModeError extends Error {
  constructor(readonly code: 'AGENT_MODE_ACTIVE_NOT_RELEASED') {
    super(code);
    this.name = 'AgentModeError';
  }
}

/**
 * Which route answered the turn live (closed): the ADR-0120 selection routes, or `grammar` when a frozen Class B grammar
 * answered a read under `c-shadow` and selection never ran (live DM test 2026-10-20).
 */
export type AgentShadowLiveSource = 'chat' | 'personal-data' | 'class-b' | 'work-surface' | 'grammar';

/** What the live turn decided (closed values only), for the one-step agreement. */
export interface AgentShadowLive {
  readonly kind: 'execute' | 'ask' | 'none';
  /**
   * The route of the fresh read / none / question decision (logged as `liveSource`). With `grammar` the decision is the
   * grammar's own catalog equivalent (`execute`), and `entryId` is absent when the grammar maps to no catalog entry.
   */
  readonly source?: AgentShadowLiveSource;
  readonly entryId?: NlCatalogEntryId;
  readonly args?: NlArgs;
}

export interface AgentShadowTurn {
  readonly text: string;
  readonly attachmentCount: number;
  readonly quotedRanges?: readonly InboundQuotedRange[];
  readonly actor: Actor;
  readonly now: IsoTimestamp;
  /** The entries offered this turn; the planner sees the READ ones only. */
  readonly entries: readonly NlCatalogEntry[];
  /** The previous selection as structure only (the turn's snapshot). */
  readonly previous?: { readonly entryId: NlWave1EntryId; readonly args: NlArgs };
  readonly direct: boolean;
  readonly live: AgentShadowLive;
}

export interface AgentRunServiceDeps {
  readonly mode: AgentMode;
  /** The capability router; the service asks it for `INTENT_SELECTION` only. */
  readonly router: { select(capability: Capability): Promise<AiProvider> };
  /** The live Actor repository: the kill switch is read at a job's start and written by the owner's phrase. */
  readonly actors: { get(id: Id): Promise<Actor | null>; save(actor: Actor): Promise<Actor> };
  readonly logger: Logger;
  /** `QUOKY_TIMEZONE`. */
  readonly timeZone: string;
  /** The selection bound (`QUOKY_NL_INTENT_TIMEOUT_MS`); the whole shadow job runs inside it. */
  readonly timeoutMs?: number;
  /** Tests only: monotonic milliseconds (default `Date.now`). */
  readonly elapsed?: () => number;
  /** Tests only: other per-actor caps. */
  readonly caps?: { readonly perHour?: number; readonly perDay?: number };
}

type ShadowOutcome = 'planned' | 'clarify' | 'ask' | 'none' | 'refused' | 'malformed' | 'skipped' | 'unavailable' | 'dropped' | 'stopped' | 'timeout';

class ShadowTimeout extends Error {
  constructor() {
    super('agent shadow timed out');
    this.name = 'ShadowTimeout';
  }
}

export class AgentRunService {
  readonly mode: AgentMode;
  /** The last shadow job (tests await it; production never does). */
  lastShadowRun: Promise<void> = Promise.resolve();
  private readonly background = new AbortController();
  private inFlight = false;
  private readonly starts = new Map<Id, number[]>();
  /** CA P3 6: drop times per live origin (grammar vs selection), for the content-free `originDropsLastHour` count. */
  private readonly drops: Record<'grammar' | 'selection', number[]> = { grammar: [], selection: [] };
  private readonly killSwitch: NlActionSwitch;

  constructor(private readonly deps: AgentRunServiceDeps) {
    // The code-level release gate (ADR-0121 S2 note): `active` exists only after the D11 gates (stage S2 P5).
    if (deps.mode === 'active') throw new AgentModeError('AGENT_MODE_ACTIVE_NOT_RELEASED');
    this.mode = deps.mode;
    this.killSwitch = new NlActionSwitch({ actors: deps.actors, logger: deps.logger });
  }

  /** The switch as this actor snapshot holds it (`running` by default). */
  switchState(actor: Pick<Actor, 'metadata'> | undefined): NlActionSwitchState {
    return actor === undefined ? 'running' : readActionSwitch(actor).state;
  }

  /**
   * Whether a shadow job may be scheduled for this turn (checked before scheduling, on the turn's actor snapshot): mode
   * `shadow`, the owner's DM, the kill switch running and no shutdown. A stopped switch logs one content-free line.
   */
  shadowAdmits(actor: Actor, direct: boolean): boolean {
    if (this.mode !== 'shadow' || !direct || this.background.signal.aborted) return false;
    if (this.switchState(actor) === 'stopped') {
      this.logShadow({ outcome: 'stopped', reason: 'kill-switch', at: 'schedule' });
      return false;
    }
    return true;
  }

  /**
   * The shadow job. Never throws; the caller starts it only after the reply was handed back. One planner call at most,
   * zero connector reads, zero M2 calls; the only output is one {@link AGENT_SHADOW_LOG_EVENT} line.
   */
  runShadow(
    turn: AgentShadowTurn,
    resolveChat: () => Promise<{ readonly id: string; readonly locality: AiExecutionLocality } | undefined>,
  ): Promise<void> {
    if (this.mode !== 'shadow' || !turn.direct || this.background.signal.aborted) return Promise.resolve();
    const clock = this.deps.elapsed ?? Date.now;
    const nowMs = clock();
    const starts = (this.starts.get(turn.actor.id) ?? []).filter((at) => nowMs - at < DAY_MS);
    this.starts.set(turn.actor.id, starts);
    const perHour = this.deps.caps?.perHour ?? AGENT_SHADOW_MAX_PER_HOUR;
    const perDay = this.deps.caps?.perDay ?? AGENT_SHADOW_MAX_PER_DAY;
    const lastHour = starts.filter((at) => nowMs - at < HOUR_MS).length;
    if (this.inFlight || lastHour >= perHour || starts.length >= perDay) {
      // CA P3 6: which origin was dropped and how often in the rolling hour, so grammar turns crowding out selection-turn
      // shadows under the cap is visible (closed values and a count only).
      const origin = turn.live.source === 'grammar' ? 'grammar' : 'selection';
      const recent = this.drops[origin].filter((at) => nowMs - at < HOUR_MS);
      recent.push(nowMs);
      this.drops[origin] = recent;
      this.logShadow({
        outcome: 'dropped',
        reason: this.inFlight ? 'in-flight' : lastHour >= perHour ? 'hourly-cap' : 'daily-cap',
        ...liveFields(turn.live),
        origin,
        originDropsLastHour: recent.length,
      });
      return Promise.resolve();
    }
    this.inFlight = true;
    starts.push(nowMs);
    const job = new AbortController();
    const stop = (): void => job.abort();
    this.background.signal.addEventListener('abort', stop, { once: true });
    const timeoutMs = this.deps.timeoutMs ?? AGENT_SHADOW_DEFAULT_TIMEOUT_MS;
    const work = this.shadow(turn, resolveChat, job.signal, nowMs);
    this.lastShadowRun = withTimeout(work, timeoutMs, job.signal)
      .catch((error: unknown) => {
        job.abort();
        if (error instanceof ShadowTimeout) {
          if (!this.background.signal.aborted) this.logShadow({ outcome: 'timeout', latencyMs: Math.max(0, clock() - nowMs) });
        } else {
          this.log('warn', 'agent_run.shadow_failed', { errorName: error instanceof Error ? error.name : typeof error });
        }
      })
      .finally(() => {
        this.inFlight = false;
        this.background.signal.removeEventListener('abort', stop);
      });
    return this.lastShadowRun;
  }

  /** Shutdown: abort a shadow job in flight (its provider call gets the signal) and refuse later ones. Idempotent. */
  stopBackground(): void {
    this.background.abort();
  }

  /**
   * ADR-0121 D7: the owner's kill-switch phrase while the agent mode is not `off` (owner DM; the caller checks the DM).
   * Persists the same `quoky.actionSwitch` record as A6-D3. `undefined` when the mode is `off` or the text is not the phrase.
   */
  async handleSwitchPhrase(actor: Actor, text: string, now: IsoTimestamp): Promise<string | undefined> {
    if (this.mode === 'off') return undefined;
    const wanted = parseActionSwitchPhrase(text);
    if (wanted === undefined) return undefined;
    const saved = await this.killSwitch.set(actor.id, actor, wanted, now);
    this.log('info', 'agent_run.switch', { state: saved ?? 'unchanged', mode: this.mode });
    return renderAgentSwitchReply(saved, languageOf(text));
  }

  /**
   * The line added to another handler's switch reply (A6 actions or the channel grants answered the phrase and saved the
   * same record) while the agent mode is not `off`; `undefined` otherwise.
   */
  switchSuffix(text: string): string | undefined {
    if (this.mode === 'off') return undefined;
    const wanted = parseActionSwitchPhrase(text);
    return wanted === undefined ? undefined : renderAgentSwitchSuffix(wanted, languageOf(text));
  }

  // ── the job ───────────────────────────────────────────────────────────────────────────────────────────────────

  private async shadow(
    turn: AgentShadowTurn,
    resolveChat: () => Promise<{ readonly id: string; readonly locality: AiExecutionLocality } | undefined>,
    signal: AbortSignal,
    startedMs: number,
  ): Promise<void> {
    const clock = this.deps.elapsed ?? Date.now;
    const latency = (): number => Math.max(0, clock() - startedMs);
    // The kill switch again, on the live actor: a stop between the reply and the job start wins.
    // Fail closed (Codex P2): a live switch state that cannot be read (the lookup threw, or no actor) skips the job; the
    // turn's snapshot is never trusted here.
    let live: Actor | null;
    try {
      live = await this.deps.actors.get(turn.actor.id);
    } catch {
      live = null;
    }
    if (live === null) {
      this.logShadow({ outcome: 'skipped', reason: 'switch-unknown', at: 'start' });
      return;
    }
    if (this.switchState(live) === 'stopped') {
      this.logShadow({ outcome: 'stopped', reason: 'kill-switch', at: 'start' });
      return;
    }
    if (signal.aborted) return;
    const prepared = prepareSelectionInput(turn.text, turn.attachmentCount, turn.quotedRanges ?? []);
    if ('skip' in prepared) {
      this.logShadow({ outcome: 'skipped', reason: prepared.skip });
      return;
    }
    // ADR-0120 D3 pre-egress credential guard over the complete outgoing request (text and previous args).
    const previousStrings = turn.previous === undefined ? [] : Object.values(turn.previous.args).filter((value): value is string => typeof value === 'string');
    if ([prepared.text, ...previousStrings].some((value) => containsCredentialMaterial(value))) {
      this.logShadow({ outcome: 'skipped', reason: 'credential' });
      return;
    }
    const chat = await resolveChat();
    if (signal.aborted) return;
    if (chat === undefined) {
      this.logShadow({ outcome: 'skipped', reason: 'chat-provider-unknown' });
      return;
    }
    let provider: AiProvider;
    try {
      provider = await this.deps.router.select(Capability.INTENT_SELECTION);
    } catch {
      this.logShadow({ outcome: 'unavailable', reason: 'no-provider', latencyMs: latency() });
      return;
    }
    const egress = nlSameEgress(provider, chat.id, chat.locality);
    if (egress !== 'same') {
      this.logShadow({ outcome: 'skipped', reason: egress });
      return;
    }
    // D4: the planner input is the owner's prepared text, the catalog and the previous selection as structure only.
    const flow = checkPlannerInputs([
      { label: OWNER_TEXT_FLOW_LABEL },
      { label: CATALOG_FLOW_LABEL },
      ...(turn.previous !== undefined ? [{ label: PREVIOUS_SELECTION_FLOW_LABEL }] : []),
    ]);
    const prompt = buildAgentPlanPrompt({ entries: turn.entries, text: prepared.text, ...(turn.previous !== undefined ? { previous: turn.previous } : {}) });
    if (flow !== undefined || plannerPromptCanaryHit(prompt, untrustedCanariesOf(turn.text, turn.quotedRanges ?? []), prepared.groundingText)) {
      this.logShadow({ outcome: 'refused', reason: flow ?? 'canary' });
      return;
    }
    if (signal.aborted) return;
    const timeoutMs = this.deps.timeoutMs ?? AGENT_SHADOW_DEFAULT_TIMEOUT_MS;
    let raw: string;
    try {
      raw = (await provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs, signal })).text;
    } catch {
      if (!signal.aborted) this.logShadow({ outcome: 'unavailable', reason: 'failed', latencyMs: latency() });
      return;
    }
    if (signal.aborted) return;
    const plan = parseAgentPlanOutput(raw);
    if (plan === null) {
      this.logShadow({ outcome: 'malformed', reason: agentPlanParseFailure(raw) ?? 'unknown', latencyMs: latency() });
      return;
    }
    const offered = new Map(turn.entries.filter((entry) => entry.risk === 'READ').map((entry) => [entry.id, entry] as const));
    const validation = validateAgentPlan(plan, {
      offered,
      groundingText: prepared.groundingText,
      ...(turn.previous !== undefined ? { previousArgs: turn.previous.args } : {}),
      now: turn.now,
      timeZone: this.deps.timeZone,
      direct: turn.direct,
    });
    this.logShadow({ ...planFields(plan, validation), ...this.agreement(plan, validation, turn), ...liveFields(turn.live), latencyMs: latency() });
  }

  /** One-step plans only: whether the plan agrees with the live selection (entry, and meaning as S1 W3 defines it). */
  private agreement(plan: AgentPlan, validation: AgentPlanValidation, turn: AgentShadowTurn): LogFields {
    // A grammar answer with no catalog equivalent has nothing to agree with: no agreement fields.
    if (turn.live.source === 'grammar' && turn.live.entryId === undefined) return {};
    if (plan.kind === 'none') {
      const agree = turn.live.kind === 'none';
      return { agree, agreeEntry: agree };
    }
    if (plan.steps.length !== 1) return {};
    // A `veto-*` refusal (ADR-0120 A7, not a request) is answered as chat, exactly as the live path's vetoed `none`
    // (CA P2 on S2 P2): it agrees with a live none.
    if (!validation.ok && validation.reason.startsWith('veto-')) {
      const agree = turn.live.kind === 'none';
      return { agree, agreeEntry: agree };
    }
    if (!validation.ok) return { agree: false, agreeEntry: false };
    if (validation.plan.kind === 'clarify') {
      const agree = turn.live.kind === 'ask';
      return { agree, agreeEntry: agree };
    }
    const step = validation.plan.kind === 'run' ? validation.plan.steps[0] : undefined;
    if (step === undefined || step.kind !== 'read' || turn.live.kind !== 'execute' || turn.live.entryId === undefined) return { agree: false, agreeEntry: false };
    const id = step.entry.id;
    const agreeEntry = id === turn.live.entryId;
    const agree =
      agreeEntry &&
      isNlWave1EntryId(id) &&
      nlSelectionMeaning({ entryId: id, args: step.args }, step.entry, turn.now, this.deps.timeZone) ===
        nlSelectionMeaning({ entryId: id, args: turn.live.args ?? {} }, step.entry, turn.now, this.deps.timeZone);
    return { agree, agreeEntry };
  }

  private logShadow(fields: LogFields & { readonly outcome: ShadowOutcome }): void {
    this.log('info', AGENT_SHADOW_LOG_EVENT, { mode: 'shadow', promptVersion: AGENT_PLAN_PROMPT_VERSION, ...fields });
  }

  private log(level: 'info' | 'warn', event: string, fields: LogFields): void {
    try {
      this.deps.logger[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

/**
 * The content-free plan fields: the step count, the closed entry ids (or `summarize:<schema>`), the argument kinds per
 * step (catalog arg kinds and `ref`, never a value), and the validator outcome. A model-made id is never copied: an id
 * that is not a closed catalog id is logged as `unknown`.
 */
function planFields(plan: AgentPlan, validation: AgentPlanValidation): LogFields & { readonly outcome: ShadowOutcome } {
  if (plan.kind === 'none') return { outcome: validation.ok ? 'none' : 'refused', steps: 0, form: plan.form, validator: validation.ok ? 'ok' : validation.reason };
  const entries = plan.steps.map((step) => (step.kind === 'summarize' ? `summarize:${closedSchema(step.schema)}` : closedEntryId(step.entryId)));
  const fields: LogFields = {
    steps: plan.steps.length,
    form: plan.form,
    entries: entries.join(','),
    ambiguity: plan.ambiguity,
    validator: validation.ok ? 'ok' : validation.reason,
  };
  if (!validation.ok) {
    return { outcome: 'refused', ...fields, ...(validation.step !== undefined ? { failedStep: validation.step } : {}), ...(validation.stepReason !== undefined ? { stepReason: validation.stepReason } : {}) };
  }
  if (validation.plan.kind === 'none') return { outcome: 'none', ...fields };
  // Decision (h): an unbounded plan is an ask with a bounded suggestion (closed bound, closed entry ids only).
  if (validation.plan.kind === 'ask') {
    const suggestion = validation.plan.suggestion.map((step) => (step.kind === 'summarize' ? `summarize:${step.schema}` : step.entry.id)).join(',');
    return { outcome: 'ask', ...fields, bound: validation.plan.bound, suggestion };
  }
  const argKinds = validation.plan.steps
    .map((step) => {
      if (step.kind === 'summarize') return 'summary';
      const kinds = Object.keys(step.args).map((name) => step.entry.args.find((spec) => spec.name === name)?.kind ?? 'unknown');
      if (step.ref !== undefined) kinds.push('ref');
      return [...new Set(kinds)].sort().join('+') || 'none';
    })
    .join(';');
  return { outcome: validation.plan.kind === 'clarify' ? 'clarify' : 'planned', ...fields, argKinds };
}

const LIVE_SOURCES: ReadonlySet<string> = new Set(['chat', 'personal-data', 'class-b', 'work-surface', 'grammar']);

/** The live decision's closed kind and route (never an argument). */
function liveFields(live: AgentShadowLive): LogFields {
  return { liveKind: live.kind, liveSource: live.source !== undefined && LIVE_SOURCES.has(live.source) ? live.source : 'unknown' };
}

/** Catalog ids are closed; anything else the model wrote is reported as `unknown`, never echoed. */
function closedEntryId(id: string): string {
  return isNlCatalogEntryId(id) ? id : 'unknown';
}

function closedSchema(schema: string): string {
  return (AGENT_PLAN_SUMMARY_SCHEMAS as readonly string[]).includes(schema) ? schema : 'unknown';
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShadowTimeout()), timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', () => reject(new ShadowTimeout()), { once: true });
  });
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function languageOf(text: string): 'ko' | 'en' {
  return /[ㄱ-ㆎ가-힣]/u.test(text) ? 'ko' : 'en';
}

/** The fixed replies of the kill-switch phrase when the agent answers it (A6 actions and channel grants off). */
export function renderAgentSwitchReply(state: NlActionSwitchState | undefined, language: 'ko' | 'en' = 'ko'): string {
  if (state === undefined) {
    return language === 'en'
      ? 'I could not save the switch. The multi-step agent keeps its previous state; please try again.'
      : '스위치를 저장하지 못했어요. 다단계 에이전트는 이전 상태 그대로예요. 다시 시도해 주세요.';
  }
  if (state === 'stopped') {
    return language === 'en'
      ? 'The multi-step agent is stopped. Exact commands still work. Send "에이전트 재개" to resume.'
      : '다단계 에이전트를 멈췄어요. 정확한 명령은 그대로 동작해요. 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
  }
  return language === 'en' ? 'The multi-step agent is running again.' : '다단계 에이전트를 다시 켰어요.';
}

/** The line added when another handler saved the switch (the same record also stops or resumes the agent). */
export function renderAgentSwitchSuffix(state: NlActionSwitchState, language: 'ko' | 'en' = 'ko'): string {
  if (state === 'stopped') return language === 'en' ? 'The multi-step agent is stopped too.' : '다단계 에이전트도 함께 멈췄어요.';
  return language === 'en' ? 'The multi-step agent is running again too.' : '다단계 에이전트도 함께 다시 켰어요.';
}

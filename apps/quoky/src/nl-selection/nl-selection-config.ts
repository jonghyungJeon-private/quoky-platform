import { NL_SELECTION_TIMEOUT_MS } from '@quoky/core';

/**
 * Natural-language selection configuration (ADR-0120 D11, D2). Parsed here, in the NL feature, and folded into
 * `QuokyConfig.nlSelection` by `config.ts` (like the reminder configuration). Typed value-free errors: the message is
 * the code only, a configured value is never echoed.
 *
 * - `QUOKY_NL_INTENT_MODE`: exactly `off`, `shadow` or `active`; default `off` (every turn byte-identical). `active` is
 *   Phase A (ratification record, decision 4): selection acts only on turns that would otherwise reach chat.
 * - `QUOKY_NL_GRAMMAR_YIELD` (ADR-0120 amendment A2): exactly `off` or `on`; default `off`. `on` lets a Class B listing
 *   grammar decline a message with a qualifier it cannot express, so selection (mode `active` only) can bind it. It sends
 *   messages the host answers today to the selector, so it is its own flag.
 * - `QUOKY_NL_PHASE` (ADR-0120 D6, ADR-0121 S1): exactly `a`, `c` or `c-shadow`; default `a` (Phase A, every turn byte-identical to
 *   before S1). `c` (Phase C) runs selection before the frozen Class B grammars, which become the fallback when the selector
 *   is unavailable; it acts in `active` only (with `shadow` it is refused at startup, `NL_PHASE_REQUIRES_ACTIVE`: that path
 *   would shadow grammar hits without the c-shadow bounds). It sends messages the host answers today to the selector (the
 *   D8 egress the owner allowed for S1), so it is its own flag. Ignored in `off`. `c-shadow` (only with `active`, else `NL_PHASE_REQUIRES_ACTIVE`): Phase A stays fully
 *   live; after a Class B grammar has answered, one background selection runs for the agreement log only.
 * - `QUOKY_NL_INTENT_MODEL`: the Claude CLI `--model` of a selection call (an alias such as `haiku`, or a full model name);
 *   default `haiku`. Adapter configuration only: Core never sees it.
 * - `QUOKY_NL_INTENT_TIMEOUT_MS` (ADR-0120 amendment A3): the per-call selection bound, an integer from 2000 to 8000;
 *   default `NL_SELECTION_TIMEOUT_MS` (6 s).
 * - `QUOKY_NL_ACTIONS` (ADR-0120 amendment A6-D8): exactly `off`, `shadow`, `local` or `external`; default `off` (no action
 *   entry is ever offered and every prompt and reply is byte-identical to `nl-select.v18`). Any other value requires
 *   `QUOKY_NL_INTENT_MODE=active` (`NL_ACTIONS_REQUIRES_ACTIVE`, a startup refusal); the composition root always builds
 *   the persisted kill switch, and the service refuses to start without it. Each non-`off` level is a Strict owner step.
 */
export type NlIntentModeConfig = 'off' | 'shadow' | 'active';
export type NlPhaseConfig = 'a' | 'c' | 'c-shadow';
export type NlActionsConfig = 'off' | 'shadow' | 'local' | 'external';

export interface NlSelectionConfig {
  readonly mode: NlIntentModeConfig;
  readonly model: string;
  /** `QUOKY_NL_GRAMMAR_YIELD=on` (amendment A2). */
  readonly grammarYield: boolean;
  /** `QUOKY_NL_PHASE` (S1): `a` (default), `c`, or `c-shadow` (only with mode `active`). */
  readonly phase: NlPhaseConfig;
  /** `QUOKY_NL_INTENT_TIMEOUT_MS` (amendment A3), milliseconds. */
  readonly timeoutMs: number;
  /** `QUOKY_NL_ACTIONS` (amendment A6): `off` (default), `shadow`, `local` or `external`. */
  readonly actions: NlActionsConfig;
}

export const DEFAULT_NL_INTENT_MODEL = 'haiku';

export const NlSelectionConfigErrorCode = {
  NL_INTENT_MODE_INVALID: 'NL_INTENT_MODE_INVALID',
  NL_INTENT_MODEL_INVALID: 'NL_INTENT_MODEL_INVALID',
  NL_GRAMMAR_YIELD_INVALID: 'NL_GRAMMAR_YIELD_INVALID',
  NL_INTENT_TIMEOUT_INVALID: 'NL_INTENT_TIMEOUT_INVALID',
  NL_PHASE_INVALID: 'NL_PHASE_INVALID',
  NL_PHASE_REQUIRES_ACTIVE: 'NL_PHASE_REQUIRES_ACTIVE',
  NL_ACTIONS_INVALID: 'NL_ACTIONS_INVALID',
  NL_ACTIONS_REQUIRES_ACTIVE: 'NL_ACTIONS_REQUIRES_ACTIVE',
} as const;
export type NlSelectionConfigErrorCode = (typeof NlSelectionConfigErrorCode)[keyof typeof NlSelectionConfigErrorCode];

export class NlSelectionConfigError extends Error {
  constructor(readonly code: NlSelectionConfigErrorCode) {
    super(code);
    this.name = 'NlSelectionConfigError';
  }
}

const MODES: readonly NlIntentModeConfig[] = ['off', 'shadow', 'active'];
const ACTION_LEVELS: readonly NlActionsConfig[] = ['off', 'shadow', 'local', 'external'];
/** The `QUOKY_CLAUDE_MODEL` shape (an alias or a full model name). */
const CLAUDE_MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const TIMEOUT_MIN_MS = 2_000;
const TIMEOUT_MAX_MS = 8_000;

/**
 * The `QUOKY_NL_INTENT_TIMEOUT_MS` rule (amendment A3), shared with the evaluation CLI: a whole number of milliseconds
 * from 2000 to 8000 written as plain digits. Returns the value, or `undefined` when the text does not satisfy it.
 */
export function parseNlIntentTimeoutMs(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= TIMEOUT_MIN_MS && value <= TIMEOUT_MAX_MS ? value : undefined;
}

export function parseNlSelectionConfig(env: NodeJS.ProcessEnv): NlSelectionConfig {
  const rawMode = env.QUOKY_NL_INTENT_MODE;
  if (rawMode !== undefined && !(MODES as readonly string[]).includes(rawMode)) {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_INTENT_MODE_INVALID);
  }
  const rawModel = env.QUOKY_NL_INTENT_MODEL;
  if (rawModel !== undefined && !CLAUDE_MODEL_SHAPE.test(rawModel)) {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_INTENT_MODEL_INVALID);
  }
  const rawYield = env.QUOKY_NL_GRAMMAR_YIELD;
  if (rawYield !== undefined && rawYield !== 'off' && rawYield !== 'on') {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_GRAMMAR_YIELD_INVALID);
  }
  const rawPhase = env.QUOKY_NL_PHASE;
  if (rawPhase !== undefined && rawPhase !== 'a' && rawPhase !== 'c' && rawPhase !== 'c-shadow') {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_PHASE_INVALID);
  }
  // `c-shadow` keeps Phase A live and shadows only grammar hits; without `active` there is no live Phase A to keep. `c`
  // with `shadow` would shadow grammar hits outside the bounded c-shadow job, so it is refused too (`c` + `off` is inert).
  if ((rawPhase === 'c-shadow' && rawMode !== 'active') || (rawPhase === 'c' && rawMode === 'shadow')) {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_PHASE_REQUIRES_ACTIVE);
  }
  const rawTimeout = env.QUOKY_NL_INTENT_TIMEOUT_MS;
  let timeoutMs = NL_SELECTION_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const value = parseNlIntentTimeoutMs(rawTimeout);
    if (value === undefined) throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_INTENT_TIMEOUT_INVALID);
    timeoutMs = value;
  }
  const rawActions = env.QUOKY_NL_ACTIONS;
  if (rawActions !== undefined && !(ACTION_LEVELS as readonly string[]).includes(rawActions)) {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_ACTIONS_INVALID);
  }
  // A6-D8: an action level needs Phase A live (`active`); the kill switch is checked by the service at construction.
  if (rawActions !== undefined && rawActions !== 'off' && rawMode !== 'active') {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_ACTIONS_REQUIRES_ACTIVE);
  }
  return {
    actions: (rawActions as NlActionsConfig | undefined) ?? 'off',
    mode: (rawMode as NlIntentModeConfig | undefined) ?? 'off',
    model: rawModel ?? DEFAULT_NL_INTENT_MODEL,
    grammarYield: rawYield === 'on',
    phase: rawPhase === 'c' || rawPhase === 'c-shadow' ? rawPhase : 'a',
    timeoutMs,
  };
}

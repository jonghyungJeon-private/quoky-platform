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
 * - `QUOKY_NL_INTENT_MODEL`: the Claude CLI `--model` of a selection call (an alias such as `haiku`, or a full model name);
 *   default `haiku`. Adapter configuration only: Core never sees it.
 * - `QUOKY_NL_INTENT_TIMEOUT_MS` (ADR-0120 amendment A3): the per-call selection bound, an integer from 2000 to 8000;
 *   default `NL_SELECTION_TIMEOUT_MS` (6 s).
 */
export type NlIntentModeConfig = 'off' | 'shadow' | 'active';

export interface NlSelectionConfig {
  readonly mode: NlIntentModeConfig;
  readonly model: string;
  /** `QUOKY_NL_GRAMMAR_YIELD=on` (amendment A2). */
  readonly grammarYield: boolean;
  /** `QUOKY_NL_INTENT_TIMEOUT_MS` (amendment A3), milliseconds. */
  readonly timeoutMs: number;
}

export const DEFAULT_NL_INTENT_MODEL = 'haiku';

export const NlSelectionConfigErrorCode = {
  NL_INTENT_MODE_INVALID: 'NL_INTENT_MODE_INVALID',
  NL_INTENT_MODEL_INVALID: 'NL_INTENT_MODEL_INVALID',
  NL_GRAMMAR_YIELD_INVALID: 'NL_GRAMMAR_YIELD_INVALID',
  NL_INTENT_TIMEOUT_INVALID: 'NL_INTENT_TIMEOUT_INVALID',
} as const;
export type NlSelectionConfigErrorCode = (typeof NlSelectionConfigErrorCode)[keyof typeof NlSelectionConfigErrorCode];

export class NlSelectionConfigError extends Error {
  constructor(readonly code: NlSelectionConfigErrorCode) {
    super(code);
    this.name = 'NlSelectionConfigError';
  }
}

const MODES: readonly NlIntentModeConfig[] = ['off', 'shadow', 'active'];
/** The `QUOKY_CLAUDE_MODEL` shape (an alias or a full model name). */
const CLAUDE_MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const TIMEOUT_MIN_MS = 2_000;
const TIMEOUT_MAX_MS = 8_000;

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
  const rawTimeout = env.QUOKY_NL_INTENT_TIMEOUT_MS;
  let timeoutMs = NL_SELECTION_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const value = /^[0-9]+$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
    if (!(value >= TIMEOUT_MIN_MS && value <= TIMEOUT_MAX_MS)) {
      throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_INTENT_TIMEOUT_INVALID);
    }
    timeoutMs = value;
  }
  return {
    mode: (rawMode as NlIntentModeConfig | undefined) ?? 'off',
    model: rawModel ?? DEFAULT_NL_INTENT_MODEL,
    grammarYield: rawYield === 'on',
    timeoutMs,
  };
}

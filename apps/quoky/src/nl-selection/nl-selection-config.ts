/**
 * Natural-language selection configuration (ADR-0120 D11, D2). Parsed here, in the NL feature, and folded into
 * `QuokyConfig.nlSelection` by `config.ts` (like the reminder configuration). Typed value-free errors: the message is
 * the code only, a configured value is never echoed.
 *
 * - `QUOKY_NL_INTENT_MODE`: exactly `off`, `shadow` or `active`; default `off` (every turn byte-identical). `active` is
 *   Phase A (ratification record, decision 4): selection acts only on turns that would otherwise reach chat.
 * - `QUOKY_NL_INTENT_MODEL`: the Claude CLI `--model` of a selection call (an alias such as `haiku`, or a full model name);
 *   default `haiku`. Adapter configuration only: Core never sees it.
 */
export type NlIntentModeConfig = 'off' | 'shadow' | 'active';

export interface NlSelectionConfig {
  readonly mode: NlIntentModeConfig;
  readonly model: string;
}

export const DEFAULT_NL_INTENT_MODEL = 'haiku';

export const NlSelectionConfigErrorCode = {
  NL_INTENT_MODE_INVALID: 'NL_INTENT_MODE_INVALID',
  NL_INTENT_MODEL_INVALID: 'NL_INTENT_MODEL_INVALID',
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

export function parseNlSelectionConfig(env: NodeJS.ProcessEnv): NlSelectionConfig {
  const rawMode = env.QUOKY_NL_INTENT_MODE;
  if (rawMode !== undefined && !(MODES as readonly string[]).includes(rawMode)) {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_INTENT_MODE_INVALID);
  }
  const rawModel = env.QUOKY_NL_INTENT_MODEL;
  if (rawModel !== undefined && !CLAUDE_MODEL_SHAPE.test(rawModel)) {
    throw new NlSelectionConfigError(NlSelectionConfigErrorCode.NL_INTENT_MODEL_INVALID);
  }
  return { mode: (rawMode as NlIntentModeConfig | undefined) ?? 'off', model: rawModel ?? DEFAULT_NL_INTENT_MODEL };
}

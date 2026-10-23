import type { NlArgValue } from '../nl-routing/catalog';
import { NL_SELECTION_OUTPUT_MAX_BYTES, parseSelectionOutput, type NlAmbiguity, type NlSelectionCandidate } from '../nl-routing/selection-output';

/**
 * ADR-0121 D1/D2/D12: the planner's output contract, schema v2 — an extension of the ADR-0120 selection output.
 *
 * The planner (M1, `INTENT_SELECTION`) returns ONE JSON object of at most 2 KB (the ADR-0120 D3 bound), in one of two
 * closed forms:
 *
 * - **the selection form** (ADR-0120 D3, unchanged): `{entryId | "none", args, ambiguity, alternatives}`. It is a one-step
 *   plan (or `none`), exactly today's selection, so the read prompt's examples stay valid outputs;
 * - **the steps form** (new): `{"steps": [step, …], "ambiguity": "CLEAR" | "NEEDS_CLARIFICATION", "related"?: true}` with 1–6
 *   steps (`related`, S2 P3 / owner decision (a): the owner asked for one read's items related to another read; Quoky reads
 *   each on its own and the reply says the relation was not checked; it changes no step). A step is
 *   either a read `{"entryId", "args"?, "ref"?}` or a summary `{"summarize": [<step no>, …], "schema": "<id>.v<N>"}`.
 *   A `ref` is `{"step": <earlier step no>, "field": "<projected id field>", "take": <1..>}`: the closed-format ids a
 *   deterministic projector takes from that earlier read (stage S2 P3), never a model-written value.
 *
 * Parsing is strict and total: unknown keys, wrong types, out-of-range numbers, more than 6 steps or more than 2 KB give
 * `null` (the caller treats the call as failed; no retry). The catalog, the step mix, the references and every argument
 * are checked later by the deterministic `plan-validator.ts`, never here.
 */

export const AGENT_PLAN_MAX_STEPS = 6;
/**
 * Parse bounds (the validator applies the ADR bounds: ≤ 4 reads, ≤ 3 summaries, ≤ 10 referenced values; a plan over them
 * is answered with a bounded suggestion, so an owner's large number still parses).
 */
const MAX_REF_TAKE_PARSED = 1000;
const MAX_SUMMARY_SOURCES = 4;
const MAX_ARGS = 12;
const MAX_ID_CHARS = 64;
const MAX_ARG_NAME_CHARS = 32;
const MAX_ARG_VALUE_CHARS = 200;
const MAX_FIELD_CHARS = 32;
const MAX_SCHEMA_CHARS = 32;

/** A reference to the closed-format ids an earlier read step yields (ADR-0121 D2). */
export interface AgentPlanRef {
  /** 1-based number of the earlier step. */
  readonly step: number;
  /** The projected id field (`issueKeys`, `messageIds`, …); checked against a closed table by the validator. */
  readonly field: string;
  /** How many values the reference carries (the validator bounds it at 10 per reference and 10 per run). */
  readonly take: number;
}

export type AgentPlanStep =
  | {
      readonly kind: 'read';
      readonly entryId: string;
      readonly args: Readonly<Record<string, NlArgValue>>;
      readonly ref?: AgentPlanRef;
    }
  | {
      readonly kind: 'summarize';
      /** 1-based numbers of the earlier read steps the summary covers. */
      readonly from: readonly number[];
      readonly schema: string;
    };

export type AgentPlan =
  /** The planner found no entry (`entryId: "none"` in the selection form): honest chat. */
  | { readonly kind: 'none'; readonly form: 'selection' }
  | {
      readonly kind: 'steps';
      readonly form: 'selection' | 'steps';
      readonly steps: readonly AgentPlanStep[];
      readonly ambiguity: NlAmbiguity;
      /** Selection form only (ADR-0120 D7): at most 2 alternatives of a one-step plan. */
      readonly alternatives: readonly NlSelectionCandidate[];
      /** Logged only; never decides anything. */
      readonly confidence?: number;
      /**
       * Steps form only (owner decision (a), 2026-10-20): the owner asked for items of one read related to another read.
       * Nothing is joined (a content value is never a query); the reply adds a fixed note that the relation was not
       * checked. It never changes, adds or removes a step.
       */
      readonly related?: true;
    };

const STEPS_TOP_KEYS = new Set(['steps', 'ambiguity', 'confidence', 'related']);
const READ_KEYS = new Set(['entryId', 'args', 'ref']);
const SUMMARY_KEYS = new Set(['summarize', 'schema']);
const REF_KEYS = new Set(['step', 'field', 'take']);

/** Parse the planner's raw text strictly (a single surrounding code fence is tolerated, as for the selection output). */
export function parseAgentPlanOutput(raw: string): AgentPlan | null {
  const value = jsonObjectOf(raw);
  if (value === null) return null;
  if (!('steps' in value)) {
    const selection = parseSelectionOutput(raw);
    if (selection === null) return null;
    if (selection.entryId === null) return { kind: 'none', form: 'selection' };
    return {
      kind: 'steps',
      form: 'selection',
      steps: [{ kind: 'read', entryId: selection.entryId, args: selection.args }],
      ambiguity: selection.ambiguity,
      alternatives: selection.alternatives,
      ...(selection.confidence !== undefined ? { confidence: selection.confidence } : {}),
    };
  }
  if (!Object.keys(value).every((key) => STEPS_TOP_KEYS.has(key))) return null;
  if (value.ambiguity !== 'CLEAR' && value.ambiguity !== 'NEEDS_CLARIFICATION') return null;
  const confidence = value.confidence;
  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence))) return null;
  // Only `true` (or absent / false) is meaningful; any other value is malformed.
  const related = value.related;
  if (related !== undefined && typeof related !== 'boolean') return null;
  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > AGENT_PLAN_MAX_STEPS) return null;
  const steps: AgentPlanStep[] = [];
  for (const rawStep of rawSteps) {
    const step = parseStep(rawStep);
    if (step === null) return null;
    steps.push(step);
  }
  return {
    kind: 'steps',
    form: 'steps',
    steps,
    ambiguity: value.ambiguity,
    alternatives: [],
    ...(typeof confidence === 'number' ? { confidence } : {}),
    ...(related === true ? { related: true as const } : {}),
  };
}

/**
 * Why `parseAgentPlanOutput` rejected a raw output, as a closed, content-free reason (`undefined` when it parses). Never a
 * model-made key or value. Logged only.
 */
export function agentPlanParseFailure(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'empty';
  if (parseAgentPlanOutput(raw) !== null) return undefined;
  if (new TextEncoder().encode(raw).length > NL_SELECTION_OUTPUT_MAX_BYTES) return 'too-large';
  const value = jsonObjectOf(raw);
  if (value === null) return 'not-json-object';
  if (!('steps' in value)) return 'selection-form-invalid';
  if (!Object.keys(value).every((key) => STEPS_TOP_KEYS.has(key))) return 'unknown-key';
  if (value.ambiguity !== 'CLEAR' && value.ambiguity !== 'NEEDS_CLARIFICATION') return 'bad-enum:ambiguity';
  if (value.related !== undefined && typeof value.related !== 'boolean') return 'bad-related';
  if (!Array.isArray(value.steps)) return 'bad-steps';
  if (value.steps.length === 0) return 'no-steps';
  if (value.steps.length > AGENT_PLAN_MAX_STEPS) return 'too-many-steps';
  return 'bad-step';
}

function jsonObjectOf(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  if (new TextEncoder().encode(raw).length > NL_SELECTION_OUTPUT_MAX_BYTES) return null;
  let body = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(body);
  if (fenced) body = (fenced[1] ?? '').trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  return isPlainObject(value) ? value : null;
}

function parseStep(value: unknown): AgentPlanStep | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if ('summarize' in value) {
    if (!keys.every((key) => SUMMARY_KEYS.has(key))) return null;
    const from = value.summarize;
    if (!Array.isArray(from) || from.length === 0 || from.length > MAX_SUMMARY_SOURCES) return null;
    if (!from.every((n) => isStepNumber(n))) return null;
    const schema = value.schema;
    if (typeof schema !== 'string' || schema.length > MAX_SCHEMA_CHARS || !/^[a-z][a-z0-9-]*\.v[1-9][0-9]?$/.test(schema)) return null;
    return { kind: 'summarize', from: from as number[], schema };
  }
  if (!keys.every((key) => READ_KEYS.has(key))) return null;
  const entryId = value.entryId;
  if (typeof entryId !== 'string' || entryId.length > MAX_ID_CHARS || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(entryId)) return null;
  const args = parseArgs(value.args);
  if (args === null) return null;
  if (value.ref === undefined || value.ref === null) return { kind: 'read', entryId, args };
  const ref = parseRef(value.ref);
  if (ref === null) return null;
  return { kind: 'read', entryId, args, ref };
}

function parseRef(value: unknown): AgentPlanRef | null {
  if (!isPlainObject(value) || !Object.keys(value).every((key) => REF_KEYS.has(key))) return null;
  const { step, field, take } = value;
  if (!isStepNumber(step)) return null;
  if (typeof field !== 'string' || field.length === 0 || field.length > MAX_FIELD_CHARS || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(field)) return null;
  if (typeof take !== 'number' || !Number.isInteger(take) || take < 1 || take > MAX_REF_TAKE_PARSED) return null;
  return { step, field, take };
}

function parseArgs(value: unknown): Record<string, NlArgValue> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_ARGS) return null;
  const args: Record<string, NlArgValue> = {};
  for (const [name, arg] of entries) {
    if (name.length === 0 || name.length > MAX_ARG_NAME_CHARS || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) return null;
    if (arg === null) continue;
    if (typeof arg === 'string') {
      if (arg.length > MAX_ARG_VALUE_CHARS) return null;
      args[name] = arg;
    } else if (typeof arg === 'boolean' || (typeof arg === 'number' && Number.isFinite(arg))) {
      args[name] = arg;
    } else {
      return null;
    }
  }
  return args;
}

function isStepNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= AGENT_PLAN_MAX_STEPS;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

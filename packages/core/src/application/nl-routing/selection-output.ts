import type { NlArgValue } from './catalog';

/**
 * The selector's output contract (ADR-0120 D3): one JSON object of at most 2 KB,
 * `{ entryId | "none", args, ambiguity: CLEAR | NEEDS_CLARIFICATION, alternatives (at most 2) }`, unknown keys rejected.
 * A `confidence` number is accepted and only ever logged. An `answer` (an integer 1-4, owner decision D4 of 2026-10-26)
 * names the option of the open numbered question the prompt showed; Core reads it only when it showed one. Parsing is
 * strict and total: anything else is `null` and the
 * runtime treats the call as failed (no retry). Ids and args are checked against the catalog later (D4), not here.
 */

/** ADR-0120 D3: the output bound, in UTF-8 bytes. */
export const NL_SELECTION_OUTPUT_MAX_BYTES = 2048;
export const NL_SELECTION_MAX_ALTERNATIVES = 2;
const MAX_ARGS = 12;
const MAX_ID_CHARS = 64;
const MAX_ARG_NAME_CHARS = 32;
const MAX_ARG_VALUE_CHARS = 200;

export type NlAmbiguity = 'CLEAR' | 'NEEDS_CLARIFICATION';

export interface NlSelectionCandidate {
  readonly entryId: string;
  readonly args: Readonly<Record<string, NlArgValue>>;
}

export interface NlSelectionOutput {
  /** `null` for `"none"`. */
  readonly entryId: string | null;
  readonly args: Readonly<Record<string, NlArgValue>>;
  readonly ambiguity: NlAmbiguity;
  readonly alternatives: readonly NlSelectionCandidate[];
  /** Logged only (ADR-0120 D3); never decides anything. */
  readonly confidence?: number;
  /** D4: the option number of the open question the prompt showed, when the message answers it in other words. */
  readonly answer?: number;
}

/** D4: the largest option number an `answer` may name (a D7 numbered question has at most 4 options). */
export const NL_SELECTION_MAX_ANSWER = 4;

const isAnswer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= NL_SELECTION_MAX_ANSWER;

const TOP_KEYS = new Set(['entryId', 'args', 'ambiguity', 'alternatives', 'confidence', 'answer']);
const ALTERNATIVE_KEYS = new Set(['entryId', 'args']);

/** Parse the selector's raw text strictly. A single surrounding code fence is tolerated; nothing else around the object. */
export function parseSelectionOutput(raw: string): NlSelectionOutput | null {
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
  if (!isPlainObject(value)) return null;
  if (!Object.keys(value).every((key) => TOP_KEYS.has(key))) return null;
  const entryId = parseEntryId(value.entryId);
  if (entryId === undefined) return null;
  const args = parseArgs(value.args);
  if (args === null) return null;
  if (value.ambiguity !== 'CLEAR' && value.ambiguity !== 'NEEDS_CLARIFICATION') return null;
  const alternatives = parseAlternatives(value.alternatives);
  if (alternatives === null) return null;
  const confidence = value.confidence;
  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence))) return null;
  if (value.answer !== undefined && value.answer !== null && !isAnswer(value.answer)) return null;
  return {
    entryId,
    args,
    ambiguity: value.ambiguity,
    alternatives,
    ...(typeof confidence === 'number' ? { confidence } : {}),
    ...(isAnswer(value.answer) ? { answer: value.answer } : {}),
  };
}

/**
 * A6 v49 gate diagnosis (2026-10-19): WHY `parseSelectionOutput` rejected a raw output, as a closed, content-free reason
 * (`undefined` when it parses). A key or arg name is reported only when the catalog defines it (`knownArgNames`, never a
 * model-made key or a value); anything else is the bare reason. Logged and recorded by the evaluation only; decides nothing.
 */
export function nlSelectionParseFailure(raw: string, knownArgNames: ReadonlySet<string> = new Set()): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'empty';
  if (parseSelectionOutput(raw) !== null) return undefined;
  if (new TextEncoder().encode(raw).length > NL_SELECTION_OUTPUT_MAX_BYTES) return 'too-large';
  let body = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(body);
  if (fenced) body = (fenced[1] ?? '').trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return body.includes('{') ? 'prose-around-json' : 'not-json';
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return 'json-invalid';
  }
  // Codex P2: a key or arg name is reported only when the catalog defines it; a model-made key is never copied out.
  const name = (key: string): string => (knownArgNames.has(key) ? `:${key}` : '');
  if (!isPlainObject(value)) return 'not-object';
  const unknownKey = Object.keys(value).find((key) => !TOP_KEYS.has(key));
  if (unknownKey !== undefined) return `unknown-key${name(unknownKey)}`;
  if (parseEntryId(value.entryId) === undefined) return 'bad-entry';
  if (value.args !== undefined) {
    if (!isPlainObject(value.args)) return 'bad-args';
    const entries = Object.entries(value.args);
    if (entries.length > MAX_ARGS) return 'too-many-args';
    for (const [arg, item] of entries) {
      if (arg.length === 0 || arg.length > MAX_ARG_NAME_CHARS || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(arg)) return `bad-arg-name${name(arg)}`;
      if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) return `bad-arg-type${name(arg)}`;
      if (typeof item === 'string' && item.length > MAX_ARG_VALUE_CHARS) return `arg-too-long${name(arg)}`;
    }
  }
  if (value.ambiguity !== 'CLEAR' && value.ambiguity !== 'NEEDS_CLARIFICATION') return 'bad-enum:ambiguity';
  if (parseAlternatives(value.alternatives) === null) return 'bad-alternatives';
  if (value.answer !== undefined && value.answer !== null && !isAnswer(value.answer)) return 'bad-answer';
  return 'bad-confidence';
}

function parseEntryId(value: unknown): string | null | undefined {
  if (value === 'none' || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_CHARS) return undefined;
  return /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(value) ? value : undefined;
}

function parseArgs(value: unknown): Record<string, NlArgValue> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_ARGS) return null;
  const args: Record<string, NlArgValue> = {};
  for (const [name, arg] of entries) {
    if (name.length === 0 || name.length > MAX_ARG_NAME_CHARS || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) return null;
    // A null arg is "not given" (models emit it for absent optional args).
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

function parseAlternatives(value: unknown): NlSelectionCandidate[] | null {
  if (value === undefined) return [];
  // v51 gate (2026-10-19, a6-negative-none-148 / -155: malformed:bad-alternatives): a hedged answer may list "none" as an
  // alternative. "none" is no candidate, so it is dropped rather than failing the whole call; it can only ever remove an
  // option, never add one. Every other rule holds (at most 2 real alternatives, closed keys, valid ids).
  if (!Array.isArray(value) || value.length > NL_SELECTION_MAX_ALTERNATIVES + 1) return null;
  const alternatives: NlSelectionCandidate[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !Object.keys(item).every((key) => ALTERNATIVE_KEYS.has(key))) return null;
    const entryId = parseEntryId(item.entryId);
    if (entryId === undefined) return null;
    if (entryId === null) continue;
    if (alternatives.length >= NL_SELECTION_MAX_ALTERNATIVES) return null;
    const args = parseArgs(item.args);
    if (args === null) return null;
    alternatives.push({ entryId, args });
  }
  return alternatives;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

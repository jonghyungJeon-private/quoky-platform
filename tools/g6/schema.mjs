// G6 harness: the `judge.v1` JSON-schema builder and the ordinal / cardinality checks (ADR-0121 A3a-D2, as corrected
// by the measurement record on 2026-10-26: `ranked` length N for `order`, min(`count`, N) for `pick` with `count`,
// 1..N for `pick` without `count`).
//
// The schema goes to Ollama as `format` (JSON-schema-constrained decoding). `validateAgainstSchema` checks a parsed
// output against the exact schema of the request (the LT dry run's "outputs parse against the request schema").
// Unique ordinals cannot be expressed for an array of objects in the schema; `checkOrdinals` is the Core check.

export const INTRO_MAX = 150;
export const WHY_MAX = 200;
export const EXTRA_MAX = 150;
export const EXTRA_MAX_ITEMS = 3;
export const COUNT_MIN = 1;
export const COUNT_MAX = 10;

/** [min, max] length of `ranked` for a request. Throws on a request the validator (V10–V12) would refuse. */
export function rankedBounds({ select, count, n }) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`item count must be a positive integer, got ${n}`);
  if (select === 'order') {
    if (count !== undefined && count !== null) throw new Error('order takes no count (V11 answer-order-count)');
    return [n, n];
  }
  if (select === 'pick') {
    if (count === undefined || count === null) return [1, n];
    if (!Number.isInteger(count) || count < COUNT_MIN || count > COUNT_MAX) {
      throw new Error(`count must be an integer ${COUNT_MIN}..${COUNT_MAX}, got ${count}`);
    }
    const k = Math.min(count, n);
    return [k, k];
  }
  throw new Error(`select must be order or pick, got ${select}`);
}

/** The `judge.v1` JSON schema of one request. */
export function buildJudgeSchema({ select, count, n }) {
  const [minItems, maxItems] = rankedBounds({ select, count, n });
  const ordinals = Array.from({ length: n }, (_, i) => i + 1);
  return {
    type: 'object',
    properties: {
      intro: { type: 'string', maxLength: INTRO_MAX },
      ranked: {
        type: 'array',
        minItems,
        maxItems,
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', enum: ordinals },
            why: { type: 'string', maxLength: WHY_MAX },
          },
          required: ['n', 'why'],
          additionalProperties: false,
        },
      },
      extra: {
        type: 'array',
        maxItems: EXTRA_MAX_ITEMS,
        items: { type: 'string', maxLength: EXTRA_MAX },
      },
    },
    required: ['intro', 'ranked', 'extra'],
    additionalProperties: false,
  };
}

function typeOk(type, value) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      throw new Error(`unsupported schema type ${type}`);
  }
}

/**
 * Validates `value` against the subset of JSON Schema that `buildJudgeSchema` emits (type, properties, required,
 * additionalProperties: false, enum, minItems, maxItems, items, maxLength in code points). Returns a list of
 * `path: problem` strings; empty means valid.
 */
export function validateAgainstSchema(schema, value, path = '$') {
  const errors = [];
  if (!typeOk(schema.type, value)) return [`${path}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not in enum`);
  if (schema.type === 'string' && schema.maxLength !== undefined && [...value].length > schema.maxLength) {
    errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateAgainstSchema(schema.items, v, `${path}[${i}]`)));
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) errors.push(`${path}: extra key ${key}`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validateAgainstSchema(sub, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

/**
 * The Core ordinal checks on `ranked` (A3a-D2 / A2-D7): every `n` an integer in 1..N, unique, and the count the
 * request's shape requires. Returns `null` when valid, else the failed check's name.
 */
export function checkOrdinals(ranked, { select, count, n }) {
  for (const entry of ranked) {
    if (!Number.isInteger(entry?.n) || entry.n < 1 || entry.n > n) return 'ordinal-range';
  }
  if (new Set(ranked.map((e) => e.n)).size !== ranked.length) return 'ordinal-unique';
  const [min, max] = rankedBounds({ select, count, n });
  if (ranked.length < min || ranked.length > max) return 'select-shape';
  return null;
}

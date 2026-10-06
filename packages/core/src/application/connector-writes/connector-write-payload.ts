import { createHash } from 'node:crypto';
import type { ConnectorWriteOperation } from '../../ports';

/** Domain separation for the ADR-0112 payload hash (bumped only with a new hash shape). */
export const CONNECTOR_WRITE_PAYLOAD_DIGEST_DOMAIN = 'quoky.connector-write.payload.v1';

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Idempotency keys are opaque, bounded tokens (for example derived from an approval id). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$/;

/**
 * The ADR-0112 payload SHA-256: domain-separated, over a canonical JSON (object keys sorted, `undefined` members
 * dropped) of the operation, the normalized target and the exact payload. The approval binds this hash and the
 * receipt stores it; the payload text itself is never stored on the receipt.
 */
export function connectorWritePayloadSha256(
  operation: ConnectorWriteOperation,
  target: string,
  payload: unknown,
): string {
  const canonical = canonicalJson({ domain: CONNECTOR_WRITE_PAYLOAD_DIGEST_DOMAIN, operation, target, payload });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function isConnectorWritePayloadSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

export function isConnectorWriteIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value);
}

/** Deterministic JSON: sorted object keys, arrays in order, `undefined` object members dropped. Throws on cycles. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('CONNECTOR_WRITE_PAYLOAD_INVALID');
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError('CONNECTOR_WRITE_PAYLOAD_INVALID');
    }
    return value;
  }
  if (seen.has(value)) throw new TypeError('CONNECTOR_WRITE_PAYLOAD_INVALID');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry === undefined ? null : entry, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = canonicalize(member, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

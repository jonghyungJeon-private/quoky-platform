import { createHash } from 'node:crypto';

/** Internal domain-separated canonical hash. Callers explicitly order their shape fields. */
export function sha256Canonical(domain: string, shape: unknown): string {
  return createHash('sha256').update(JSON.stringify({ domain, shape })).digest('hex');
}

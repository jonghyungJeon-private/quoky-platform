/* eslint-disable no-console */
import { now } from '@quoky/core';
import type { Logger, LogFields } from '@quoky/core';
import { currentCorrelation } from './correlation-context';
import { redactSecrets } from './error-diagnostics';
import { isoWithOffset } from './security/iso-time';

/**
 * The ONE place `console` is used. A namespaced, console-backed `Logger`.
 * Output: `<ISO-8601 with offset> [namespace] message key=value … cid=<id>` (undefined fields omitted).
 *
 * ADR-0121 S0 (MSIT ⑤-2): every line starts with the host-local time and its numeric offset, and a line written
 * inside an owner turn or a reminder tick ends with that turn's content-free correlation id (`cid`, see
 * `correlation-context.ts`), which the traffic ledger records too. The whole line passes `redactSecrets` as defence
 * in depth; callers still log names, codes and ids only, never message text or a credential.
 *
 * This is the v1 implementation of the Logger seam; a future LoggerProvider can
 * replace it in the composition root without touching call sites.
 */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly namespace: string,
    private readonly clock: () => Date = () => new Date(now()),
  ) {}

  info(message: string, fields?: LogFields): void {
    console.log(this.format(message, fields));
  }

  warn(message: string, fields?: LogFields): void {
    console.warn(this.format(message, fields));
  }

  error(message: string, fields?: LogFields): void {
    console.error(this.format(message, fields));
  }

  private format(message: string, fields?: LogFields): string {
    const pairs = fields
      ? Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v}`)
      : [];
    const correlation = currentCorrelation();
    if (correlation !== undefined && fields?.cid === undefined) pairs.push(`cid=${correlation.cid}`);
    const line = `${isoWithOffset(this.clock())} [${this.namespace}] ${message}${pairs.length ? ` ${pairs.join(' ')}` : ''}`;
    return redactSecrets(line);
  }
}

import path from 'node:path';
import type { Logger } from '@quoky/core';
import type { QuokyConfig } from '../config';
import { EgressGuard, installEgressGuard } from './egress-guard';
import type { InstalledEgressGuard } from './egress-guard';
import { buildEgressInventory } from './egress-policy';
import { LEDGER_DIR_NAME, TrafficLedger } from './traffic-ledger';

/**
 * Composition-root wiring of the ADR-0121 S0 egress guard (design §5.2/§5.4). `main.ts` calls {@link startEgressGuard}
 * once, right after the configuration is loaded and before the application module (and with it every adapter, client
 * and timer) is evaluated, so no in-process connection can precede the guard.
 *
 * `QUOKY_EGRESS_GUARD=off` installs nothing. Otherwise the allowlist is derived from the configuration, logged by name,
 * and the traffic ledger is opened under `<data dir>/audit/` (no file ledger for an in-memory database).
 */

/** `<directory of the database file>/audit`, or `undefined` for an in-memory or unset database path. */
export function egressLedgerDir(dbPath: string, cwd: string = process.cwd()): string | undefined {
  if (dbPath === '' || dbPath === ':memory:') return undefined;
  return path.join(path.dirname(path.resolve(cwd, dbPath)), LEDGER_DIR_NAME);
}

export function startEgressGuard(config: QuokyConfig, logger: Logger): InstalledEgressGuard | undefined {
  const { mode } = config.egress;
  if (mode === 'off') {
    logger.info('egress.guard.off');
    return undefined;
  }
  const inventory = buildEgressInventory(config);
  const dir = egressLedgerDir(config.storage.dbPath);
  const ledger =
    dir === undefined
      ? undefined
      : new TrafficLedger({
          dir,
          maxFileBytes: config.egress.ledgerMaxFileBytes,
          retentionDays: config.egress.ledgerRetentionDays,
          logger,
        });
  const installed = installEgressGuard(new EgressGuard({ mode, inventory, logger, ...(ledger !== undefined ? { ledger } : {}) }));
  // Names only: the allowlisted hosts, the local endpoints, and the ledger directory (an operator-owned path).
  logger.info('egress.guard.started', {
    mode,
    hosts: [...inventory.hosts.keys()].sort().join(','),
    local: inventory.localEndpoints.map((endpoint) => `${endpoint.host}:${endpoint.port}`).join(','),
    ledgerDir: dir ?? 'none',
    childProcesses: 'not-covered',
  });
  return installed;
}

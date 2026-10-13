import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '@quoky/core';
import { loadConfig } from '../config';
import { egressLedgerDir, startEgressGuard } from './egress-wiring';

const OWNER = '111111111111111111';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recordingLogger(): Logger & { lines: Array<{ message: string; fields?: LogFields }> } {
  const lines: Array<{ message: string; fields?: LogFields }> = [];
  const push = (message: string, fields?: LogFields): void => {
    lines.push({ message, ...(fields ? { fields } : {}) });
  };
  return { lines, info: push, warn: push, error: push };
}

describe('egress guard wiring (ADR-0121 S0)', () => {
  it('the ledger lives in <data dir>/audit; an in-memory database has no file ledger', () => {
    expect(egressLedgerDir('/srv/quoky/data/chunsik.db')).toBe('/srv/quoky/data/audit');
    expect(egressLedgerDir('data/chunsik.db', '/repo')).toBe('/repo/data/audit');
    expect(egressLedgerDir(':memory:')).toBeUndefined();
    expect(egressLedgerDir('')).toBeUndefined();
  });

  it('QUOKY_EGRESS_GUARD=off installs nothing', () => {
    const before = getGlobalDispatcher();
    const logger = recordingLogger();
    const config = loadConfig({ QUOKY_DISCORD_OWNER_IDS: OWNER, QUOKY_EGRESS_GUARD: 'off', QUOKY_DB_PATH: ':memory:' });
    expect(startEgressGuard(config, logger)).toBeUndefined();
    expect(getGlobalDispatcher()).toBe(before);
    expect(logger.lines).toEqual([{ message: 'egress.guard.off' }]);
  });

  it('the default (observe) installs the guard and logs the allowlist by name only, never a secret', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'quoky-wiring-'));
    dirs.push(dir);
    const before = getGlobalDispatcher();
    const logger = recordingLogger();
    const slackToken = ['xo', 'xp-'].join('') + '1234-5678-abcdef';
    const config = loadConfig({
      QUOKY_DISCORD_OWNER_IDS: OWNER,
      QUOKY_DB_PATH: path.join(dir, 'chunsik.db'),
      QUOKY_SLACK_TOKEN: slackToken,
      QUOKY_OLLAMA_ENABLED: 'false',
    });
    const installed = startEgressGuard(config, logger);
    try {
      expect(installed?.guard.mode).toBe('observe');
      expect(getGlobalDispatcher()).not.toBe(before);
      expect(logger.lines).toEqual([
        {
          message: 'egress.guard.started',
          fields: {
            mode: 'observe',
            hosts: 'cdn.discordapp.com,discord.com,gateway.discord.gg,media.discordapp.net,slack.com',
            local: '',
            ledgerDir: path.join(dir, 'audit'),
            childProcesses: 'not-covered',
          },
        },
      ]);
      expect(JSON.stringify(logger.lines)).not.toContain(slackToken);
    } finally {
      await installed?.uninstall();
    }
    expect(getGlobalDispatcher()).toBe(before);
  });
});

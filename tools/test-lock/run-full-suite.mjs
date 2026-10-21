#!/usr/bin/env node
// `pnpm test`: `vitest run` behind the machine-wide full-suite lock (see full-suite-lock.mjs).
//
//   pnpm test                      full suite: takes the lock (waits while another full suite runs)
//   QUOKY_TEST_NO_WAIT=1 pnpm test full suite, but exit 75 at once when the lock is held
//   pnpm test <file|filter> [...]   targeted run (first argument is not an option): no lock
//   pnpm vitest run <files>         targeted run: never goes through this wrapper, no lock
//
// The vitest caps (maxWorkers 2, forks pool, bounded teardown) stay in vitest.config.ts.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, defaultLockDir, recordChild, release } from './full-suite-lock.mjs';

export const EXIT_LOCK_HELD = 75;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const raw = process.argv.slice(2);
const args = raw[0] === '--' ? raw.slice(1) : raw;
const targeted = args.length > 0 && !args[0].startsWith('-');
const vitest = createRequire(resolve(repoRoot, 'package.json')).resolve('vitest/vitest.mjs');
const log = (line) => process.stderr.write(`[test-lock] ${line}\n`);

const lockDir = defaultLockDir();
let held = false;
if (!targeted) {
  held = await acquire(lockDir, { noWait: process.env.QUOKY_TEST_NO_WAIT === '1', log, info: { argv: args } });
  if (!held) process.exit(EXIT_LOCK_HELD);
  log(`full-suite lock taken (${lockDir})`);
}
const releaseOnce = () => {
  if (held) {
    held = false;
    release(lockDir);
  }
};
process.on('exit', releaseOnce);

// vitest runs in its own process group so a signal reaches its fork workers too, and the group is swept when vitest
// exits: a SIGTERM to the vitest main process alone leaves its workers orphaned (PPID 1, ~1-3.5 GB each).
const child = spawn(process.execPath, [vitest, 'run', ...args], { cwd: repoRoot, stdio: 'inherit', detached: true });
if (held && child.pid !== undefined) recordChild(lockDir, child.pid);
const signalGroup = (signal) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group is already gone
  }
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    // Forward to the whole group and wait for vitest to exit; the lock is released then.
    signalGroup(signal);
  });
}
child.on('exit', (code, signal) => {
  signalGroup('SIGKILL');
  releaseOnce();
  process.exit(code ?? (signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1) : 1));
});
child.on('error', (error) => {
  log(`could not start vitest: ${error.message}`);
  releaseOnce();
  process.exit(1);
});

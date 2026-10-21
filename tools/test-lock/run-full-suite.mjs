#!/usr/bin/env node
// `pnpm test`: `vitest run` behind the machine-wide full-suite lock (see full-suite-lock.mjs).
//
//   pnpm test                      full suite: takes the lock (waits while another full suite runs)
//   QUOKY_TEST_NO_WAIT=1 pnpm test full suite, but exit 75 at once when the lock is held
//   pnpm test <file> [...]          targeted run: at least one non-option argument and EVERY non-option argument is an
//                                   existing regular `*.test.*` / `*.spec.*` file: no lock. Any other argument (a filter, a directory, an option
//                                   value such as `--reporter verbose`) takes the lock like a full suite.
//   pnpm test --version | --help    prints vitest's version / help; never runs tests, takes no lock
//   pnpm vitest run <files>         targeted run: never goes through this wrapper, no lock
//   QUOKY_TEST_LOCK_DRY_RUN=1       lock handling only: exits 0 right before vitest would be spawned (tests of the lock)
//
// The vitest caps (maxWorkers 2, forks pool, bounded teardown) stay in vitest.config.ts.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, defaultLockDir, recordChild, release } from './full-suite-lock.mjs';

export const EXIT_LOCK_HELD = 75;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const raw = process.argv.slice(2);
const args = raw[0] === '--' ? raw.slice(1) : raw;
const vitest = createRequire(resolve(repoRoot, 'package.json')).resolve('vitest/vitest.mjs');
const log = (line) => process.stderr.write(`[test-lock] ${line}\n`);

// `--version` / `--help` never start a run (`vitest run --version` would run the whole suite).
if (args.includes('--version') || args.includes('-v')) {
  const manifest = JSON.parse(readFileSync(resolve(dirname(vitest), 'package.json'), 'utf8'));
  process.stdout.write(`vitest/${manifest.version}\n`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  // `vitest --help` (no `run`) prints the help and exits.
  process.exit(spawnSync(process.execPath, [vitest, '--help'], { cwd: repoRoot, stdio: 'inherit' }).status ?? 0);
}

// The native modules (better-sqlite3) are built for the `.nvmrc` Node: another major fails hundreds of tests with
// NODE_MODULE_VERSION errors that read like real failures (2026-10-22: 472 on Node 18). Refuse before any run.
export const EXIT_NODE_MISMATCH = 78;
try {
  const wanted = readFileSync(resolve(repoRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '').split('.')[0];
  const running = process.versions.node.split('.')[0];
  if (wanted !== '' && wanted !== running && process.env.QUOKY_TEST_ALLOW_NODE_MISMATCH !== '1') {
    log(`Node ${process.versions.node} is running, but .nvmrc wants Node ${wanted}: native modules would fail to load.`);
    log(`Use the .nvmrc Node (e.g. PATH="$HOME/.nvm/versions/node/v${readFileSync(resolve(repoRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '')}/bin:$PATH") and rerun.`);
    process.exit(EXIT_NODE_MISMATCH);
  }
} catch {
  // No readable .nvmrc: nothing to check.
}

const isFile = (path) => {
  try {
    return statSync(resolve(repoRoot, path)).isFile();
  } catch {
    return false;
  }
};
// The token after a value-taking option is its value, not a file (`--config vitest.config.ts` is not a targeted run).
const VALUE_OPTIONS = new Set(['-c', '--config', '--root', '-r', '--dir', '--project', '-t', '--testNamePattern', '--reporter', '--outputFile', '--exclude', '--pool', '--mode', '--environment']);
const positional = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg.startsWith('-')) {
    if (VALUE_OPTIONS.has(arg)) index += 1;
  } else {
    positional.push(arg);
  }
}
// A targeted run names test files only: every positional must look like one AND exist (a filter, a directory, the value of
// an option this list does not know, such as `--exclude a.test.ts` after an unknown option, lock like a full suite).
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const targeted = positional.length > 0 && positional.every((arg) => TEST_FILE.test(arg) && isFile(arg));

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

if (process.env.QUOKY_TEST_LOCK_DRY_RUN === '1') {
  log(`dry run: would run vitest run ${args.join(' ')} (targeted: ${targeted})`);
  process.exit(0);
}

// vitest runs in its own process group so a signal reaches its fork workers too, and the group is swept when vitest
// exits: a SIGTERM to the vitest main process alone leaves its workers orphaned (PPID 1, ~1-3.5 GB each). If this wrapper
// itself is SIGKILLed nothing sweeps the group, so the vitest tree preloads a watchdog that kills the group when the
// wrapper PID is gone.
const watchdog = resolve(here, 'wrapper-watchdog.cjs');
const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(watchdog)}`.trim();
const child = spawn(process.execPath, [vitest, 'run', ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  detached: true,
  env: { ...process.env, QUOKY_TEST_WRAPPER_PID: String(process.pid), NODE_OPTIONS: nodeOptions },
});
if (held && child.pid !== undefined) recordChild(lockDir, child.pid);
const signalGroup = (signal) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group is already gone
  }
};
let firstSignalAt;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    // Forward to the whole group and wait for vitest to exit (the lock is released then). A terminal delivers one Ctrl-C to
    // several processes at once, so signals within 1 s of the first are duplicates; a later one means the owner is not
    // waiting any longer: escalate to SIGKILL on the group.
    const now = Date.now();
    if (firstSignalAt === undefined) {
      firstSignalAt = now;
      signalGroup(signal);
    } else if (now - firstSignalAt >= 1000) {
      signalGroup('SIGKILL');
    }
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

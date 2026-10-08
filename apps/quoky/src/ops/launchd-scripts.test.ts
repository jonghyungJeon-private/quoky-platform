/**
 * Offline tests for the ADR-0102 launchd scripts (SUB-1): `ops/launchd/quoky-launch.sh` (run/print-env) and
 * `ops/launchd/quokyctl.sh` (install/uninstall/restart in --dry-run only, status, render, backup).
 *
 * Safety: every script runs with a temp HOME, a stub `launchctl` (QUOKY_LAUNCHCTL) that records its arguments and
 * changes nothing, and a fake `node` that records its environment. quokyctl install/uninstall/restart are never run
 * with --apply here, so the owner's login session is never touched; the dry-run plan is the same code path --apply
 * executes step by step. `backup --apply` touches no launchd state: it runs against a temp HOME's data directory only.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { LocalVectorProvider } from '@quoky/vector-local';
import { REMINDER_TICK_STOP_TIMEOUT_MS } from '../reminders/reminder-tick-driver';
import { QuokyExitCode } from './exit-codes';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const OPS_DIR = path.join(REPO_ROOT, 'ops', 'launchd');
const LAUNCHER = path.join(OPS_DIR, 'quoky-launch.sh');
const CTL = path.join(OPS_DIR, 'quokyctl.sh');
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const SECRET_MARKER = 'DISCORD_BOT_TOKEN=secret-token-value-never-printed';
const MIB = 1024 * 1024;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  bin: string;
  home: string;
  repo: string;
  envFile: string;
  node: string;
  dataDir: string;
  logDir: string;
  launchctlLog: string;
  launchctl: string;
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

/** Temp HOME, a repo with a built-looking app, a private env file, a fake node and a stub launchctl. */
function sandbox(options: { loaded?: boolean } = {}): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), 'quoky-launchd-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo & co');
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(path.join(repo, 'apps', 'quoky', 'dist'), { recursive: true });
  writeFileSync(path.join(repo, 'apps', 'quoky', 'dist', 'main.js'), '');
  const envFile = path.join(repo, '.env.local');
  writeFileSync(envFile, `${SECRET_MARKER}\n`);
  chmodSync(envFile, 0o600);
  // Fake node: records its environment and argv next to main.js, then exits with <dist>/exit-code (default 0).
  const node = path.join(bin, 'node');
  writeExecutable(
    node,
    [
      '#!/bin/sh',
      'd=$(dirname "$1")',
      'env > "$d/child-env.txt"',
      'echo "$@" > "$d/child-argv.txt"',
      'umask > "$d/child-umask.txt"',
      'if [ -f "$d/wait-for-term" ]; then',
      '  trap \'echo term > "$d/got-term"; exit 0\' TERM',
      '  echo $$ > "$d/child.pid"',
      '  while :; do sleep 0.05; done',
      'fi',
      'code=$(cat "$d/exit-code" 2>/dev/null || echo 0)',
      'exit "$code"',
      '',
    ].join('\n'),
  );
  const launchctlLog = path.join(root, 'launchctl.log');
  const launchctl = path.join(bin, 'launchctl-stub');
  writeExecutable(
    launchctl,
    [
      '#!/bin/sh',
      `echo "$*" >> "${launchctlLog}"`,
      'if [ "$1" = print ]; then',
      options.loaded ? '  echo "\tstate = running"; echo "\tpid = 4242"; echo "\tlast exit code = 0"; exit 0' : '  exit 113',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  return {
    root,
    bin,
    home,
    repo,
    envFile,
    node,
    dataDir: path.join(home, 'Library', 'Application Support', 'Quoky'),
    logDir: path.join(home, 'Library', 'Logs', 'Quoky'),
    launchctlLog,
    launchctl,
  };
}

function baseEnv(box: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: `${box.bin}:${SYSTEM_PATH}`, HOME: box.home, QUOKY_LAUNCHCTL: box.launchctl, ...extra };
}

function launcherArgs(box: Sandbox, command: 'run' | 'print-env' = 'run'): string[] {
  return [
    LAUNCHER,
    command,
    '--repo', box.repo,
    '--env-file', box.envFile,
    '--node', box.node,
    '--path', `/opt/homebrew/bin:${SYSTEM_PATH}`,
    '--home', box.home,
    '--data-dir', box.dataDir,
    '--log-dir', box.logDir,
  ];
}

function runLauncher(box: Sandbox, extraEnv: Record<string, string> = {}) {
  return spawnSync('/bin/bash', launcherArgs(box), { env: baseEnv(box, extraEnv), encoding: 'utf8', timeout: 20_000 });
}

function runCtl(box: Sandbox, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [CTL, ...args, '--repo', box.repo], {
    env: baseEnv(box, extraEnv),
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function dist(box: Sandbox, name: string): string {
  return path.join(box.repo, 'apps', 'quoky', 'dist', name);
}

function childEnv(box: Sandbox): Map<string, string> {
  const entries = readFileSync(dist(box, 'child-env.txt'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const);
  // The fake node is a /bin/sh script; sh itself adds PWD, SHLVL and _. Real node receives exactly the env -i set.
  return new Map(entries.filter(([name]) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name)));
}

function stubUname(box: Sandbox, os: string): void {
  writeExecutable(path.join(box.bin, 'uname'), `#!/bin/sh\necho ${os}\n`);
}

function launcherLog(box: Sandbox): string {
  return readFileSync(path.join(box.logDir, 'quoky.log'), 'utf8');
}

function configExits(box: Sandbox): string | undefined {
  const file = path.join(box.dataDir, 'launcher', 'config-exits');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
}

const CHILD_ENV_NAMES = [
  'HOME',
  'PATH',
  'LANG',
  'USER',
  'LOGNAME',
  'QUOKY_ENV_FILE',
  'QUOKY_RUNTIME_ENV',
  'QUOKY_DB_PATH',
  'QUOKY_VECTOR_PATH',
  'QUOKY_LAUNCHER',
  'QUOKY_LAUNCHER_RECENT_STARTS',
];

const INHERITED = {
  DISCORD_BOT_TOKEN: 'inherited-token',
  DISCORD_GUILD_ID: '999999999999999999',
  QUOKY_DB_PATH: '/inherited/db',
  QUOKY_RUNTIME_ENV: 'dev',
  ANTHROPIC_API_KEY: 'inherited-key',
  NODE_OPTIONS: '--require /inherited/hook.js',
};

describe('exit code contract (ADR-0102 D5)', () => {
  it('the shell scripts and the app agree on the configuration exit code', () => {
    const lib = readFileSync(path.join(OPS_DIR, 'quoky-ops-lib.sh'), 'utf8');
    expect(lib).toMatch(new RegExp(`^QUOKY_EXIT_CONFIGURATION=${QuokyExitCode.CONFIGURATION}$`, 'm'));
  });
});

describe('quoky-launch.sh print-env: the pure environment construction (ADR-0102 D2)', () => {
  it('prints exactly the fixed environment and nothing inherited from the caller', () => {
    const box = sandbox();
    const result = spawnSync('/bin/bash', launcherArgs(box, 'print-env'), {
      env: { ...baseEnv(box), ...INHERITED },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.map((line) => line.slice(0, line.indexOf('=')))).toEqual(CHILD_ENV_NAMES);
    expect(result.stdout).not.toMatch(/DISCORD_|ANTHROPIC_|NODE_OPTIONS|inherited/);
    expect(lines).toContain(`QUOKY_ENV_FILE=${box.envFile}`);
    expect(lines).toContain('QUOKY_RUNTIME_ENV=prod');
    expect(lines).toContain(`QUOKY_DB_PATH=${box.dataDir}/quoky.db`);
    expect(lines).toContain(`QUOKY_VECTOR_PATH=${box.dataDir}/vectors`);
    expect(lines).toContain(`PATH=/opt/homebrew/bin:${SYSTEM_PATH}`);
    expect(lines).toContain(`HOME=${box.home}`);
    expect(result.stdout).not.toContain('secret-token-value');
  });

  it('refuses relative paths with the configuration code', () => {
    const box = sandbox();
    const args = launcherArgs(box, 'print-env');
    args[args.indexOf('--env-file') + 1] = '.env.local';
    const result = spawnSync('/bin/bash', args, { env: baseEnv(box), encoding: 'utf8' });
    expect(result.status).toBe(78);
    expect(result.stderr).toContain('--env-file must be an absolute path');
  });
});

describe.skipIf(process.platform !== 'darwin')('quoky-launch.sh run (ADR-0102 D2, D5, D7, D8)', () => {
  it('starts node on the built app with only the fixed environment (no inherited DISCORD_*) and exits with its status', () => {
    const box = sandbox();
    const result = runLauncher(box, INHERITED);
    expect(result.status).toBe(0);
    const env = childEnv(box);
    expect([...env.keys()].sort()).toEqual([...CHILD_ENV_NAMES].sort());
    for (const name of Object.keys(INHERITED).filter((n) => !CHILD_ENV_NAMES.includes(n))) expect(env.has(name)).toBe(false);
    expect(env.get('QUOKY_DB_PATH')).toBe(`${box.dataDir}/quoky.db`);
    expect(env.get('QUOKY_RUNTIME_ENV')).toBe('prod');
    expect(env.get('QUOKY_LAUNCHER')).toBe('launchd');
    expect(env.get('QUOKY_LAUNCHER_RECENT_STARTS')).toBe('1');
    expect(readFileSync(dist(box, 'child-argv.txt'), 'utf8').trim()).toBe(dist(box, 'main.js'));
    // The launcher's own files are private (077); the app runs with the usual 022.
    expect(readFileSync(dist(box, 'child-umask.txt'), 'utf8').trim()).toBe('0022');
    expect(spawnSync('stat', ['-f', '%Lp', path.join(box.logDir, 'quoky.log')], { encoding: 'utf8' }).stdout.trim()).toBe('600');
    // The log names variables only; no value and no env file content.
    const log = launcherLog(box);
    expect(log).toContain('environment: HOME PATH LANG');
    expect(log).not.toContain('secret-token-value');
    expect(log).not.toContain('inherited');
    // Private directories.
    expect(spawnSync('stat', ['-f', '%Lp', box.logDir], { encoding: 'utf8' }).stdout.trim()).toBe('700');
    expect(spawnSync('stat', ['-f', '%Lp', box.dataDir], { encoding: 'utf8' }).stdout.trim()).toBe('700');
  });

  it('propagates a crash status (launchd relaunches it) and counts recent starts', () => {
    const box = sandbox();
    writeFileSync(dist(box, 'exit-code'), '1');
    expect(runLauncher(box).status).toBe(1);
    expect(runLauncher(box).status).toBe(1);
    expect(runLauncher(box).status).toBe(1);
    expect(childEnv(box).get('QUOKY_LAUNCHER_RECENT_STARTS')).toBe('3');
    expect(configExits(box)).toBeUndefined();
  });

  it.each([
    ['group-readable env file', (box: Sandbox) => chmodSync(box.envFile, 0o640), 'ENV_FILE_INSECURE'],
    ['world-readable env file', (box: Sandbox) => chmodSync(box.envFile, 0o644), 'ENV_FILE_INSECURE'],
    ['missing env file', (box: Sandbox) => rmSync(box.envFile), 'ENV_FILE_MISSING'],
    [
      'symlinked env file',
      (box: Sandbox) => {
        const target = path.join(box.root, 'real.env');
        writeFileSync(target, 'X=1\n', { mode: 0o600 });
        rmSync(box.envFile);
        symlinkSync(target, box.envFile);
      },
      'ENV_FILE_INSECURE',
    ],
    ['unbuilt app', (box: Sandbox) => rmSync(dist(box, 'main.js')), 'the app is not built'],
  ])('refuses to start with a %s (exit 78, counted, node never runs)', (_name, breakIt, reason) => {
    const box = sandbox();
    breakIt(box);
    const result = runLauncher(box);
    expect(result.status).toBe(78);
    expect(existsSync(dist(box, 'child-env.txt'))).toBe(false);
    expect(launcherLog(box)).toContain(reason);
    expect(launcherLog(box)).not.toContain('secret-token-value');
    expect(configExits(box)).toBe('1');
  });

  it('stops relaunching after 3 consecutive configuration exits (exit 0) until the count is cleared', () => {
    const box = sandbox();
    writeFileSync(dist(box, 'exit-code'), '78');
    expect(runLauncher(box).status).toBe(78);
    expect(runLauncher(box).status).toBe(78);
    expect(runLauncher(box).status).toBe(78);
    expect(configExits(box)).toBe('3');
    rmSync(dist(box, 'child-env.txt'));
    const stopped = runLauncher(box);
    expect(stopped.status).toBe(0);
    expect(existsSync(dist(box, 'child-env.txt'))).toBe(false);
    expect(launcherLog(box)).toContain('not starting: 3 consecutive configuration exits');
    // quokyctl restart/install clear the file; then a healthy run resets the count.
    rmSync(path.join(box.dataDir, 'launcher', 'config-exits'));
    writeFileSync(dist(box, 'exit-code'), '0');
    expect(runLauncher(box).status).toBe(0);
    expect(configExits(box)).toBeUndefined();
  });

  it('a non-configuration exit resets the consecutive configuration-exit count', () => {
    const box = sandbox();
    writeFileSync(dist(box, 'exit-code'), '78');
    runLauncher(box);
    runLauncher(box);
    expect(configExits(box)).toBe('2');
    writeFileSync(dist(box, 'exit-code'), '1');
    expect(runLauncher(box).status).toBe(1);
    expect(configExits(box)).toBeUndefined();
  });

  it('rotates quoky.log at start above 10 MiB, keeping 5 numbered files and touching nothing else', () => {
    const box = sandbox();
    mkdirSync(box.logDir, { recursive: true });
    const log = path.join(box.logDir, 'quoky.log');
    writeFileSync(log, '');
    truncateSync(log, 10 * MIB + 1);
    for (let i = 1; i <= 5; i += 1) writeFileSync(`${log}.${i}`, `old-${i}`);
    writeFileSync(path.join(box.logDir, 'other.txt'), 'keep');
    expect(runLauncher(box).status).toBe(0);
    expect(readFileSync(`${log}.2`, 'utf8')).toBe('old-1');
    expect(readFileSync(`${log}.5`, 'utf8')).toBe('old-4');
    expect(readFileSync(`${log}.1`).length).toBe(10 * MIB + 1);
    expect(readFileSync(log, 'utf8')).toContain('starting');
    expect(readdirSync(box.logDir).sort()).toEqual(
      ['other.txt', 'quoky.log', 'quoky.log.1', 'quoky.log.2', 'quoky.log.3', 'quoky.log.4', 'quoky.log.5'].sort(),
    );
  });

  it('does not rotate a log at or below 10 MiB', () => {
    const box = sandbox();
    mkdirSync(box.logDir, { recursive: true });
    const log = path.join(box.logDir, 'quoky.log');
    writeFileSync(log, 'previous run\n');
    expect(runLauncher(box).status).toBe(0);
    expect(existsSync(`${log}.1`)).toBe(false);
    expect(readFileSync(log, 'utf8')).toMatch(/^previous run\n/);
  });

  it('forwards SIGTERM to the app and exits with the app status (graceful stop)', async () => {
    const box = sandbox();
    writeFileSync(dist(box, 'wait-for-term'), '');
    const child = spawn('/bin/bash', launcherArgs(box), { env: baseEnv(box), stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 10_000;
    while (!existsSync(dist(box, 'child.pid')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(dist(box, 'child.pid'))).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(existsSync(dist(box, 'got-term'))).toBe(true);
  }, 20_000);

  it('refuses on a non-macOS host with a clear message', () => {
    const box = sandbox();
    stubUname(box, 'Linux');
    const result = runLauncher(box);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain('macOS only');
    expect(existsSync(dist(box, 'child-env.txt'))).toBe(false);
  });
});

describe('quokyctl.sh guards', () => {
  it('refuses on a non-macOS host before doing anything', () => {
    const box = sandbox();
    stubUname(box, 'Linux');
    const result = runCtl(box, ['install', '--dry-run']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('macOS only');
    expect(existsSync(box.launchctlLog)).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('install/uninstall/restart need an explicit --dry-run or --apply', () => {
    const box = sandbox();
    for (const command of ['install', 'uninstall', 'restart']) {
      const result = runCtl(box, [command]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('needs --dry-run (show the plan) or --apply (run it)');
    }
    expect(existsSync(box.launchctlLog)).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('quokyctl.sh render (ADR-0102 D1, D8)', () => {
  it('renders a valid plist with absolute, XML-escaped paths, the ADR timings and no secrets or environment', () => {
    const box = sandbox();
    const result = runCtl(box, ['render']);
    expect(result.status).toBe(0);
    const plist = result.stdout;
    const file = path.join(box.root, 'rendered.plist');
    writeFileSync(file, plist);
    expect(spawnSync('plutil', ['-lint', '-s', file]).status).toBe(0);
    const json = JSON.parse(
      spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout,
    ) as Record<string, unknown>;
    expect(json.Label).toBe('com.quoky.personal');
    expect(json.RunAtLoad).toBe(true);
    expect(json.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(json.ThrottleInterval).toBe(10);
    expect(json.ExitTimeOut).toBe(90);
    expect((json.ExitTimeOut as number) * 1000).toBeGreaterThan(REMINDER_TICK_STOP_TIMEOUT_MS);
    expect(json.EnvironmentVariables).toBeUndefined();
    expect(json.WorkingDirectory).toBe(box.repo);
    expect(json.StandardOutPath).toBe(`${box.logDir}/launchd.log`);
    const args = json.ProgramArguments as string[];
    expect(args.slice(0, 3)).toEqual(['/bin/bash', LAUNCHER, 'run']);
    expect(args).toEqual(
      expect.arrayContaining(['--repo', box.repo, '--env-file', box.envFile, '--node', box.node, '--data-dir', box.dataDir]),
    );
    const childPath = args[args.indexOf('--path') + 1]!;
    expect(childPath.split(':')).toEqual([box.bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    expect(plist).toContain('repo &amp; co');
    expect(plist).not.toContain('@@');
    expect(plist).not.toContain('<!--');
    expect(plist).not.toContain('secret-token-value');
  });

  it('puts the claude and ollama directories on the service PATH when they are installed', () => {
    const box = sandbox();
    const tools = path.join(box.root, 'tools');
    mkdirSync(tools);
    writeExecutable(path.join(tools, 'claude'), '#!/bin/sh\n');
    writeExecutable(path.join(tools, 'ollama'), '#!/bin/sh\n');
    const result = spawnSync('/bin/bash', [CTL, 'render', '--repo', box.repo], {
      env: { ...baseEnv(box), PATH: `${box.bin}:${tools}:${SYSTEM_PATH}` },
      encoding: 'utf8',
    });
    expect(result.stdout).toContain(`<string>${box.bin}:${tools}:/usr/bin:/bin:/usr/sbin:/sbin</string>`);
  });
});

describe.skipIf(process.platform !== 'darwin')('quokyctl.sh install --dry-run (idempotent plan, ADR-0102 D1)', () => {
  function plistPath(box: Sandbox): string {
    return path.join(box.home, 'Library', 'LaunchAgents', 'com.quoky.personal.plist');
  }

  it('fresh host: plans directories, the plist and bootstrap, and changes nothing', () => {
    const box = sandbox();
    const result = runCtl(box, ['install', '--dry-run']);
    expect(result.status).toBe(0);
    const plan = result.stdout.split('\n').filter((line) => line.startsWith('plan:'));
    expect(plan).toEqual([
      `plan:  create ${box.home}/Library/LaunchAgents`,
      `plan:  ensure ${box.logDir} exists with mode 700`,
      `plan:  ensure ${box.dataDir} exists with mode 700`,
      `plan:  write ${plistPath(box)} (mode 644)`,
      `plan:  load the agent: launchctl bootstrap gui/${process.getuid?.()} ${plistPath(box)}`,
    ]);
    expect(result.stdout).toContain('dry-run: nothing was changed');
    expect(result.stdout).not.toContain('secret-token-value');
    expect(readdirSync(box.home)).toEqual([]);
    expect(readFileSync(box.launchctlLog, 'utf8').trim().split('\n')).toEqual([
      `print gui/${process.getuid?.()}/com.quoky.personal`,
    ]);
  });

  it('already installed and loaded with the same plist: no write and no reload', () => {
    const box = sandbox({ loaded: true });
    mkdirSync(path.dirname(plistPath(box)), { recursive: true });
    writeFileSync(plistPath(box), `${runCtl(box, ['render']).stdout}`);
    const result = runCtl(box, ['install', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('note:  plist is already up to date');
    expect(result.stdout).toContain('note:  agent is already loaded with this plist: no reload');
    expect(result.stdout).not.toMatch(/plan: {2}(write|load|unload)/);
    const calls = readFileSync(box.launchctlLog, 'utf8').trim().split('\n');
    expect(calls.every((call) => call.startsWith('print '))).toBe(true);
  });

  it('loaded with a different plist: rewrite, then bootout before bootstrap', () => {
    const box = sandbox({ loaded: true });
    mkdirSync(path.dirname(plistPath(box)), { recursive: true });
    writeFileSync(plistPath(box), '<plist>old</plist>\n');
    const result = runCtl(box, ['install', '--dry-run']);
    const plan = result.stdout.split('\n').filter((line) => line.startsWith('plan:'));
    const write = plan.findIndex((line) => line.includes('write '));
    const bootout = plan.findIndex((line) => line.includes('launchctl bootout gui/'));
    const bootstrap = plan.findIndex((line) => line.includes('launchctl bootstrap gui/'));
    expect(write).toBeGreaterThan(-1);
    expect(bootout).toBeGreaterThan(write);
    expect(bootstrap).toBeGreaterThan(bootout);
    expect(readFileSync(plistPath(box), 'utf8')).toBe('<plist>old</plist>\n');
  });

  it('plans clearing a configuration-exit stop left by the launcher', () => {
    const box = sandbox();
    mkdirSync(path.join(box.dataDir, 'launcher'), { recursive: true });
    writeFileSync(path.join(box.dataDir, 'launcher', 'config-exits'), '3\n');
    const result = runCtl(box, ['install', '--dry-run']);
    expect(result.stdout).toContain('plan:  clear the configuration-exit stop');
    expect(configExits(box)).toBe('3');
  });

  it.each([
    ['a world-readable env file', (box: Sandbox) => chmodSync(box.envFile, 0o644), 'ENV_FILE_INSECURE'],
    ['a missing env file', (box: Sandbox) => rmSync(box.envFile), 'ENV_FILE_MISSING'],
    ['an unbuilt app', (box: Sandbox) => rmSync(dist(box, 'main.js')), 'the app is not built'],
  ])('refuses with %s and changes nothing', (_name, breakIt, reason) => {
    const box = sandbox();
    breakIt(box);
    const result = runCtl(box, ['install', '--dry-run']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(reason);
    expect(result.stderr).toContain('install refused; nothing was changed');
    expect(readdirSync(box.home)).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'darwin')('quokyctl.sh uninstall/restart --dry-run and status', () => {
  function install(box: Sandbox): string {
    const plist = path.join(box.home, 'Library', 'LaunchAgents', 'com.quoky.personal.plist');
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, runCtl(box, ['render']).stdout);
    return plist;
  }

  it('uninstall plans bootout and plist removal and keeps data and logs', () => {
    const box = sandbox({ loaded: true });
    const plist = install(box);
    const result = runCtl(box, ['uninstall', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`plan:  unload the agent: launchctl bootout gui/${process.getuid?.()}/com.quoky.personal`);
    expect(result.stdout).toContain(`plan:  remove ${plist}`);
    expect(result.stdout).toContain(`note:  kept: ${box.dataDir}`);
    expect(existsSync(plist)).toBe(true);
  });

  it('uninstall on a clean host is a no-op', () => {
    const box = sandbox();
    const result = runCtl(box, ['uninstall', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('note:  not installed: nothing to do');
    expect(result.stdout).not.toContain('plan:');
  });

  it('restart plans clearing the stop and kickstart -k', () => {
    const box = sandbox({ loaded: true });
    install(box);
    mkdirSync(path.join(box.dataDir, 'launcher'), { recursive: true });
    writeFileSync(path.join(box.dataDir, 'launcher', 'config-exits'), '3\n');
    const result = runCtl(box, ['restart', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('plan:  clear the configuration-exit stop');
    expect(result.stdout).toContain(`plan:  restart the agent: launchctl kickstart -k gui/${process.getuid?.()}/com.quoky.personal`);
    expect(configExits(box)).toBe('3');
  });

  it('status is read-only and reports launchd state, the configuration-exit count and paths', () => {
    const box = sandbox({ loaded: true });
    install(box);
    const result = runCtl(box, ['status']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('launchd: loaded');
    expect(result.stdout).toContain('state = running');
    expect(result.stdout).toContain('configuration exits in a row: 0');
    expect(result.stdout).toContain(`logs:    ${box.logDir}/quoky.log`);
    expect(result.stdout).toContain('instance lock: none');
    // ADR-0102 D4 lock directory: status shows the highest generation (numeric order, not lexical).
    const lockDir = path.join(box.home, 'Library', 'Application Support', 'Quoky', 'quoky.db.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'gen-9'), '{"state":"released","pid":1}\n');
    writeFileSync(path.join(lockDir, 'gen-10'), '{"state":"held","pid":4242}\n');
    writeFileSync(path.join(lockDir, 'tmp-x-held-11'), '{"state":"held","pid":7}\n');
    expect(runCtl(box, ['status']).stdout).toContain(`instance lock: ${lockDir}/gen-10 {"state":"held","pid":4242}`);
    expect(readFileSync(box.launchctlLog, 'utf8').trim().split('\n').every((c) => c.startsWith('print '))).toBe(true);
    expect(runCtl(box, ['status', '--apply']).status).not.toBe(0);
  });
});

describe.skipIf(process.platform !== 'darwin')('quokyctl.sh backup (on-demand, while the service runs)', () => {
  const BACKUP_ENV_NAMES = ['HOME', 'PATH', 'LANG', 'QUOKY_DB_PATH', 'QUOKY_VECTOR_PATH', 'QUOKY_LAUNCHER'];

  function tools(box: Sandbox, name = ''): string {
    return path.join(box.repo, 'apps', 'quoky', 'dist', 'tools', name);
  }

  /** A sandbox with the built-looking backup tool and a service database. */
  function backupSandbox(options: { loaded?: boolean } = {}): Sandbox {
    const box = sandbox(options);
    mkdirSync(tools(box), { recursive: true });
    writeFileSync(tools(box, 'backup-now.js'), '');
    mkdirSync(box.dataDir, { recursive: true });
    writeFileSync(path.join(box.dataDir, 'quoky.db'), '');
    return box;
  }

  function toolEnv(box: Sandbox): Map<string, string> {
    const entries = readFileSync(tools(box, 'child-env.txt'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const);
    return new Map(entries.filter(([name]) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name)));
  }

  const toolArgv = (box: Sandbox): string => readFileSync(tools(box, 'child-argv.txt'), 'utf8').trim();

  it('defaults to a dry-run: runs the tool read-only in the fixed environment, nothing inherited, no launchd change', () => {
    const box = backupSandbox({ loaded: true });
    const result = runCtl(box, ['backup'], INHERITED);
    expect(result.status).toBe(0);
    expect(toolArgv(box)).toBe(`${tools(box, 'backup-now.js')} --dry-run`);
    const env = toolEnv(box);
    expect([...env.keys()].sort()).toEqual([...BACKUP_ENV_NAMES].sort());
    expect(env.get('QUOKY_DB_PATH')).toBe(path.join(box.dataDir, 'quoky.db'));
    expect(env.get('QUOKY_VECTOR_PATH')).toBe(path.join(box.dataDir, 'vectors'));
    // The tool gets no env-file path at all: it never reads the env file.
    expect(env.has('QUOKY_ENV_FILE')).toBe(false);
    expect(env.get('QUOKY_LAUNCHER')).toBe('launchd');
    expect(result.stdout).toContain('(loaded); no restart: the copy only reads the database and the vector store');
    expect(result.stdout).toContain("dry-run: nothing was changed (run 'quokyctl.sh backup --apply' to take the copy)");
    expect(`${result.stdout}${result.stderr}`).not.toContain('secret-token-value');
    expect(readFileSync(box.launchctlLog, 'utf8').trim().split('\n').every((c) => c.startsWith('print '))).toBe(true);
    expect(runCtl(box, ['backup', '--dry-run']).status).toBe(0);
  });

  it('passes the same DB and vector paths the launcher gives the service', () => {
    const box = backupSandbox();
    expect(runCtl(box, ['backup']).status).toBe(0);
    const service = spawnSync('/bin/bash', launcherArgs(box, 'print-env'), { env: baseEnv(box), encoding: 'utf8' });
    const serviceEnv = new Map(
      service.stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
    );
    const env = toolEnv(box);
    expect(env.get('QUOKY_DB_PATH')).toBe(serviceEnv.get('QUOKY_DB_PATH'));
    expect(env.get('QUOKY_VECTOR_PATH')).toBe(serviceEnv.get('QUOKY_VECTOR_PATH'));
  });

  it('forwards only the backup keys from the env file, verbatim from plain NAME=value lines; no other line is passed', () => {
    const box = backupSandbox();
    writeFileSync(
      box.envFile,
      [
        SECRET_MARKER,
        '# QUOKY_BACKUP_DIR=/commented/out',
        'QUOKY_BACKUP_DIR=/Volumes/Old Backup/quoky',
        'QUOKY_BACKUP_DIR=/Volumes/Backup/quoky',
        'QUOKY_TIMEZONE=Asia/Seoul',
        'QUOKY_BACKUP_DIRS=/not/this/key',
        'ANTHROPIC_API_KEY=secret-token-value-never-printed-2',
        '',
      ].join('\n'),
    );
    chmodSync(box.envFile, 0o600);
    expect(runCtl(box, ['backup']).status).toBe(0);
    const env = toolEnv(box);
    expect(env.get('QUOKY_BACKUP_DIR')).toBe('/Volumes/Backup/quoky');
    expect(env.get('QUOKY_TIMEZONE')).toBe('Asia/Seoul');
    expect(env.has('QUOKY_BACKUP_ENABLED')).toBe(false);
    expect([...env.keys()].sort()).toEqual([...BACKUP_ENV_NAMES, 'QUOKY_BACKUP_DIR', 'QUOKY_TIMEZONE'].sort());
    expect([...env.values()].join('\n')).not.toContain('secret-token-value');
  });

  it.each([
    ['export QUOKY_BACKUP_DIR=/x'],
    ['QUOKY_BACKUP_DIR="/x"'],
    ["QUOKY_TIMEZONE='Asia/Seoul'"],
    ['QUOKY_BACKUP_ENABLED=true # on'],
    ['  QUOKY_BACKUP_DIR=/x'],
    ['QUOKY_BACKUP_DIR =/x'],
  ])('refuses a backup key the service would read differently: %s', (line) => {
    const box = backupSandbox();
    writeFileSync(box.envFile, `${SECRET_MARKER}\n${line}\n`);
    chmodSync(box.envFile, 0o600);
    const result = runCtl(box, ['backup']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be one plain line");
    expect(existsSync(tools(box, 'child-argv.txt'))).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain('secret-token-value');
  });

  it('--apply runs the tool with --apply and reports a partial set (vector snapshot failed) as a failure', () => {
    const box = backupSandbox();
    const ok = runCtl(box, ['backup', '--apply']);
    expect(ok.status).toBe(0);
    expect(toolArgv(box)).toBe(`${tools(box, 'backup-now.js')} --apply`);
    expect(ok.stdout).toContain('apply: take a manual backup (verified DB copy + vector snapshot)');
    expect(ok.stdout).toContain('backed up: see backups/backup-status.json (lastManual)');
    expect(existsSync(box.launchctlLog) ? readFileSync(box.launchctlLog, 'utf8') : '').not.toMatch(/bootstrap|bootout|kickstart/);

    writeFileSync(tools(box, 'exit-code'), '4');
    const partial = runCtl(box, ['backup', '--apply']);
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain('backup did not fully verify (exit 4, see above); the service was not touched');
  });

  it('--verify NAME is read-only and takes only a copy name', () => {
    const box = backupSandbox();
    const name = 'quoky-20261007T190000Z-daily.db';
    expect(runCtl(box, ['backup', '--verify', name]).status).toBe(0);
    expect(toolArgv(box)).toBe(`${tools(box, 'backup-now.js')} --verify ${name}`);
    for (const bad of ['../quoky.db', 'quoky.db', 'quoky-20261007T190000Z-weekly.db']) {
      const result = runCtl(box, ['backup', '--verify', bad]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--verify takes a copy name');
    }
    expect(runCtl(box, ['backup', '--verify', name, '--apply']).stderr).toContain('backup --verify is read-only');
    // A disaster-recovery drill needs no live database.
    rmSync(path.join(box.dataDir, 'quoky.db'));
    rmSync(tools(box, 'child-argv.txt'));
    expect(runCtl(box, ['backup', '--verify', name]).status).toBe(0);
    expect(toolArgv(box)).toBe(`${tools(box, 'backup-now.js')} --verify ${name}`);
    expect(runCtl(box, ['backup', '--apply']).stderr).toContain('no service database');
    expect(runCtl(box, ['status', '--verify', name]).stderr).toContain('--verify belongs to the backup command');
  });

  it.each([
    ['an unbuilt tool', (box: Sandbox) => rmSync(tools(box, 'backup-now.js')), 'the app is not built'],
    ['a world-readable env file', (box: Sandbox) => chmodSync(box.envFile, 0o644), 'ENV_FILE_INSECURE'],
    ['no service database', (box: Sandbox) => rmSync(path.join(box.dataDir, 'quoky.db')), 'no service database'],
  ])('refuses with %s before running anything', (_name, breakIt, reason) => {
    const box = backupSandbox();
    breakIt(box);
    const result = runCtl(box, ['backup', '--apply']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('backup refused');
    expect(result.stderr).toContain(reason);
    expect(existsSync(tools(box, 'child-argv.txt'))).toBe(false);
  });

  const BUILT_TOOL = path.join(REPO_ROOT, 'apps', 'quoky', 'dist', 'tools', 'backup-now.js');
  it.skipIf(!existsSync(BUILT_TOOL))('end to end with the built tool: a verified manual set in a temp HOME, then --verify', async () => {
    const box = sandbox();
    mkdirSync(box.dataDir, { recursive: true });
    const storage = new SqliteStorageProvider({ dbPath: path.join(box.dataDir, 'quoky.db') });
    await storage.init();
    await storage.close();
    await new LocalVectorProvider(path.join(box.dataDir, 'vectors')).upsert('durable-memory-v1', [
      { id: 'memory-1', vector: [0.5, 0.5], metadata: { contentHash: 'a' } },
    ]);
    const run = (args: string[]) =>
      spawnSync('/bin/bash', [CTL, 'backup', ...args, '--repo', REPO_ROOT, '--env-file', box.envFile, '--node', process.execPath], {
        env: baseEnv(box),
        encoding: 'utf8',
        timeout: 60_000,
      });
    const applied = run(['--apply']);
    expect(applied.status).toBe(0);
    const backups = path.join(box.dataDir, 'backups');
    const copy = readdirSync(backups).find((n) => /^quoky-\d{8}T\d{6}Z-manual\.db$/.test(n)) as string;
    expect(readdirSync(backups).filter((n) => n !== '.backup-lock.db').sort()).toEqual(
      ['backup-status.json', copy, copy.replace(/\.db$/, '.vectors')].sort(),
    );
    expect(applied.stdout).toContain('(1 collection(s), 1 record(s))');
    expect(`${applied.stdout}${applied.stderr}`).not.toContain('secret-token-value');

    const verified = run(['--verify', copy]);
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain('this copy and its vector snapshot are a matching set');
  }, 60_000);
});

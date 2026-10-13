/**
 * `pnpm security:secret-scan [--no-history] [--no-tree] [--json] [--summary]`: scans the repository (cwd) for
 * credential-shaped values (ADR-0121 S0). Every hit is streamed as it is found (file, commit, line, fingerprint, value
 * masked). Exit 0 = complete and nothing gates; 1 = at least one gating hit (a non-test hit, or an issued-key candidate
 * in any path, whose fingerprint is not reviewed); 2 = usage error or incomplete scan (git failure, unreadable tracked
 * path), always listed in the output. There is no hit cap and no size cap.
 */
import { runSecretScan } from './secret-scan';

function write(text: string): void | Promise<void> {
  if (process.stdout.write(text)) return undefined;
  return new Promise((resolve) => process.stdout.once('drain', () => resolve()));
}

async function main(argv: readonly string[]): Promise<number> {
  const known = new Set(['--no-history', '--no-tree', '--json', '--summary']);
  if (argv.some((a) => !known.has(a))) {
    process.stderr.write('usage: secret-scan [--no-history] [--no-tree] [--json] [--summary]\n');
    return 2;
  }
  return runSecretScan({
    cwd: process.cwd(),
    tree: !argv.includes('--no-tree'),
    history: !argv.includes('--no-history'),
    mode: argv.includes('--json') ? 'json' : argv.includes('--summary') ? 'summary' : 'list',
    write,
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`secret-scan: failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
    process.exitCode = 2;
  },
);
